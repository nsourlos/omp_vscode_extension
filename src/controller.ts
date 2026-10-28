/**
 * Glue between omp (ACP), the chat panel and the diff review.
 * Every permission/approval omp asks for becomes a card in the chat; every file
 * write becomes a hunk-by-hunk review before anything is saved.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import * as vscode from "vscode";
import { AgentError, RpcError } from "./acp/rpc";
import {
	MAX_READ_BYTES,
	attachedChipOf,
	chipOf,
	isChipThumbnail,
	prepareAttachment,
	promptBlocks,
	textTokenBudget,
	type Attachment,
	type AttachmentSource,
} from "./attachments";
import type {
	ConfigOption,
	ElicitationParams,
	ElicitationResult,
	PermissionOption,
	ReadTextFileParams,
	RequestPermissionParams,
	RequestPermissionResult,
	SavedSession,
	SessionUpdate,
	WriteTextFileParams,
} from "./acp/types";
import type { ChatPanel } from "./chatPanel";
import { completeInFolder, gitStagePaths, mentionsIn, rankMentions, splitMentionQuery, type MentionItem } from "./mentions";
import { OmpAgent, REPLAYED_UPDATES, bunCertificateProblem, bunVersion, ompSavedToken, resolveOmpCommand } from "./omp/agent";
import { addSavedLogins, loadMcpServers, mcpConfigFiles } from "./omp/mcp";
import {
	DIFF_REVIEWED_TOOLS,
	PREFER_EDIT_TOOL_PROMPT,
	codeOfToolInput,
	commandParts,
	fileChangeWarning,
	parseApprovalMessage,
	readScope,
	rejectedCommandMessage,
	rejectionMessage,
	staleFileMessage,
	urlsIn,
} from "./omp/policy";
import { applyDecisions } from "./review/hunks";
import type { ReviewManager } from "./review/reviewManager";

interface PendingRequest {
	resolve: (value: any) => void;
	cancelValue: unknown;
	/** A command's card: allows its read-only programs from now on (the checkbox). */
	allowReadOnly?: () => void;
	/** A permission's card: sends the note given with "Reject with note…", and the command as changed there. */
	rejectNote?: (note: string, changed: string | undefined) => void;
}

interface QueuedMessage {
	id: string;
	text: string;
	attachments: Attachment[];
}

/** How many replies may be followed by an attempt to name an untitled chat. */
const MAX_NAMING_ATTEMPTS = 3;

/** The most files the @ suggestions search, and how long their list is reused while one types. */
const MAX_MENTION_FILES = 20_000;
const FILE_LIST_TTL_MS = 10_000;

/** The extension's own permission option; answered to omp as "allow once". */
const ALLOW_READ_ONLY = "omp-vscode:allow-read-only";

let nextRequestId = 1;
let nextQueuedId = 1;
let nextAttachmentId = 1;
let nextControllerId = 1;

/** Runs one chat session: its own omp process, cards and review queue. */
export class Controller implements vscode.Disposable {
	readonly id = String(nextControllerId++);
	#agent: OmpAgent | undefined;
	#starting: Promise<OmpAgent> | undefined;
	#pending = new Map<string, PendingRequest>();
	#busy = false;
	#stopRequested = false;
	/** The read-only programs (cd, grep…) the user chose to always allow; for as long as this chat tab is open. */
	#allowedReadOnly = new Set<string>();
	#namingAttempts = 0;
	/** The omp session whose conversation the chat already shows, so loading it again replays nothing. */
	#shownSessionId: string | undefined;
	/** The saved chat being loaded right now, if any. */
	#loadingSessionId: string | undefined;
	/** A message waits in the queue for a saved chat to finish loading. */
	#waitingForLoad = false;
	/** True while omp is naming the chat, so its reply is not shown. */
	#naming = false;
	/** Code of the tool calls still running (eval), so a bare "Allow tool: browser" can show what it will do. */
	#runningCode = new Map<string, string>();
	#queue: QueuedMessage[] = [];
	/** Files attached in the input and not sent yet, by id; the chat page shows their chips. */
	#drafts = new Map<string, Attachment>();
	/** The file being attached; the next waits for it (#attach). */
	#attaching: Promise<void> = Promise.resolve();
	/** The last sent message whose @ mentions are being read; the next waits for it, so messages keep their order. */
	#resolvingMentions: Promise<void> = Promise.resolve();
	/** How many sent messages wait for their @ mentions to be read. */
	#mentionsPending = 0;
	/** The workspace's files for the @ suggestions, listed at most every FILE_LIST_TTL_MS. */
	#fileList: { at: number; files: Promise<string[]> } | undefined;
	/** Copies of attached files that came with no location, for omp to read; removed when the chat closes. */
	readonly copiesDir: string;
	#disposed = false;
	/** This tab has shown the warning about omp's Bun trusting leaked certificate authorities. */
	#warnedAboutBun = false;
	/** omp's last word on its context window, which sets how much text a message may attach. */
	#context: { used: number; size: number } | undefined;
	#lastNotice: string | undefined;
	#disposables: vscode.Disposable[] = [];

	constructor(
		private readonly chat: ChatPanel,
		private readonly reviews: ReviewManager,
		private readonly log: (line: string) => void,
		/** The folder of every chat's copies, private to this user (see removeStaleCopies). */
		copiesRoot: string,
		/** A saved chat to load on first start; after that (e.g. a restart after a crash) a fresh one opens. */
		private resumeSessionId?: string,
		/** The saved chat has no name yet: name it once it has loaded. */
		private readonly nameOnLoad = false,
	) {
		this.copiesDir = join(copiesRoot, `${process.pid}-${this.id}`);
		this.#disposables.push(
			chat.onMessage(message => this.#onChatMessage(message)),
			reviews.onDidChangeReview(info => {
				if (info.owner === this.id) chat.post({ type: "review", info });
			}),
		);
	}

	/**
	 * Run one turn. A message sent while a turn runs waits in a queue, because omp's ACP mode
	 * cancels the running turn when a second prompt arrives; queued messages go together as
	 * the next turn, and the chime waits for that one.
	 */
	async send(text: string, attachments: Attachment[] = []): Promise<void> {
		// Until a saved chat has loaded (or while it loads again after omp stopped), a message shows as
		// queued at once and is sent after the replayed conversation; if the chat can't load, it goes back to the input.
		// One typed while a queued message still waits (e.g. while the loaded chat is named) queues behind it, in order.
		const loading = this.resumeSessionId !== undefined || this.#waitingForLoad;
		if (this.#busy || loading) {
			const id = String(nextQueuedId++);
			this.#queue.push({ id, text, attachments });
			this.chat.post({ type: "queued", id, text, attachments: attachments.map(chipOf) });
			if (!this.#busy) void this.#sendWhenLoaded();
			return;
		}
		this.#busy = true;
		this.#stopRequested = false;
		this.#lastNotice = undefined;
		this.#runningCode.clear();
		attachments = await this.#withinTextBudget(attachments);
		this.chat.post({ type: "user", text, attachments: attachments.map(chipOf) });
		this.chat.post({ type: "status", state: "busy" });
		let agent: OmpAgent | undefined;
		let finished = false;
		try {
			agent = await this.#ensureAgent();
			const started = Date.now();
			// omp ignores a cancel before its session exists, so a Stop pressed during startup is applied here.
			const result = this.#stopRequested ? { stopReason: "cancelled" as const } : await agent.prompt(promptBlocks(text, attachments));
			this.chat.post({
				type: "turnEnd",
				stopReason: result.stopReason,
				seconds: Math.round((Date.now() - started) / 1000),
				model: currentModelName(agent.configOptions),
			});
			finished = result.stopReason !== "cancelled" && !this.#stopRequested;
		} catch (error) {
			if (!agent || agent === this.#agent) this.#notice("error", errorText(error));
		} finally {
			this.#busy = false;
			// If this turn's omp exited, #onAgentExit has already reported it.
			if (!agent || agent === this.#agent) this.chat.post({ type: "status", state: this.#agent ? "idle" : "stopped" });
		}
		// Stop empties the queue, so anything queued after a Stop was typed to replace the stopped turn.
		if ((finished || this.#stopRequested) && this.#queue.length > 0) return this.#sendTurn(this.#takeNextTurn());
		this.#returnQueueToInput();
		this.chat.markFinished();
		if (finished && vscode.workspace.getConfiguration("omp").get<boolean>("soundOnFinish", true)) {
			this.chat.notify({ type: "chime" });
		}
		if (!finished || !this.#agent || !this.#needsName()) return;
		this.#busy = true; // a message sent while the chat is being named waits in the queue
		this.chat.post({ type: "status", state: "naming" });
		await this.#nameIfUntitled(this.#agent);
		this.#busy = false;
		if (!this.#agent) {
			this.#returnQueueToInput(); // omp exited while naming: queued messages must not start a fresh, empty chat
			return;
		}
		if (this.#queue.length > 0) return this.#sendTurn(this.#takeNextTurn());
		this.chat.post({ type: "status", state: this.#agent ? "idle" : "stopped" });
	}

	/** Send queued messages as one turn: their texts together, and all their attachments. */
	#sendTurn(messages: QueuedMessage[]): Promise<void> {
		return this.send(joinTexts(messages), messages.flatMap(message => message.attachments));
	}

	/** Send what was queued while a saved chat loaded, once it has; if it can't load, the messages go back to the input. */
	async #sendWhenLoaded(): Promise<void> {
		if (this.#waitingForLoad) return;
		this.#waitingForLoad = true;
		this.#lastNotice = undefined; // a failure on this attempt is news, even if it reads like the last one
		try {
			await this.#ensureAgent();
		} catch (error) {
			this.#notice("error", errorText(error));
			this.#returnQueueToInput();
			return;
		} finally {
			this.#waitingForLoad = false;
		}
		if (!this.#busy && this.#queue.length > 0) await this.#sendTurn(this.#takeNextTurn());
	}

	/** The chat has no name yet (from omp, or the saved chat's), and omp may still be asked for one. */
	#needsName(): boolean {
		return !this.chat.chatTitle && this.#namingAttempts < MAX_NAMING_ATTEMPTS;
	}

	/**
	 * omp names chats only in its terminal app, so the extension asks it to after a reply, until it has a name:
	 * `/rename` with no title makes omp name the chat from the conversation. Its reply
	 * ("Session renamed to …") is kept out of the chat.
	 */
	async #nameIfUntitled(agent: OmpAgent): Promise<void> {
		// omp gives no name to a chat with nothing to name yet ("hi"), so it is asked again after later replies.
		if (!this.#needsName()) return;
		this.#namingAttempts++;
		this.#naming = true;
		try {
			const result = await agent.prompt("/rename");
			if (result.stopReason === "cancelled") this.#namingAttempts--; // stopped by the user: asked again after a later reply
		} catch (error) {
			this.log(`naming the chat failed: ${errorText(error)}`);
		} finally {
			this.#naming = false;
		}
	}

	/** The omp session this tab shows (the saved one it will load, before it starts). */
	get sessionId(): string | undefined {
		return this.#agent?.sessionId ?? this.resumeSessionId;
	}

	/** Stop the turn; queued messages go back into the input box rather than being sent. */
	cancel(): void {
		this.#stopRequested = true;
		this.#returnQueueToInput();
		this.#agent?.cancel();
		this.#cancelPending("Stopped by user");
	}

	/**
	 * The queued messages for the next turn: a slash command on its own, since omp reads one only
	 * at the start of a prompt, otherwise the plain messages up to the next slash command.
	 */
	#takeNextTurn(): QueuedMessage[] {
		const isCommand = (message: QueuedMessage) => isSlashCommand(message.text);
		let count = 1;
		if (!isCommand(this.#queue[0])) {
			while (count < this.#queue.length && !isCommand(this.#queue[count])) count++;
		}
		const next = this.#queue.slice(0, count);
		this.#dequeue(next);
		return next;
	}

	#takeQueue(): QueuedMessage[] {
		const queued = this.#queue;
		this.#dequeue(queued);
		return queued;
	}

	/** Take these messages out of the queue and off the chat's queued list. */
	#dequeue(messages: QueuedMessage[]): void {
		if (messages.length === 0) return;
		this.#queue = this.#queue.filter(message => !messages.includes(message));
		this.chat.post({ type: "dequeued", ids: messages.map(message => message.id) });
	}

	/** Put the queued messages back in the input, their attachments back on it. */
	#returnQueueToInput(): void {
		const queued = this.#takeQueue();
		if (queued.length === 0) return;
		const attachments = queued.flatMap(message => message.attachments);
		for (const attachment of attachments) this.#drafts.set(attachment.id, attachment);
		this.chat.notify({ type: "restoreInput", text: joinTexts(queued), attachments: attachments.map(chipOf) });
	}

	/** The attachments with these ids (from the chat page), taken out of the input's drafts. */
	#takeDrafts(ids: unknown): Attachment[] {
		if (!Array.isArray(ids)) return [];
		const taken: Attachment[] = [];
		for (const id of ids) {
			const attachment = this.#drafts.get(id);
			if (!attachment) continue;
			this.#drafts.delete(id);
			taken.push(attachment);
		}
		return taken;
	}

	async #pickFiles(): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: true,
			canSelectFiles: true,
			canSelectFolders: false,
			defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
			openLabel: "Attach",
			title: "Attach files to your message",
		});
		for (const uri of uris ?? []) void this.#attach(() => this.#sourceOf(uri));
	}

	/** Attach files from outside the chat page (the Explorer's menu), once the page can show their chips. */
	attachFiles(uris: readonly vscode.Uri[]): void {
		const loaded = this.chat.whenReady();
		for (const uri of uris) {
			void this.#attach(async () => {
				await loaded;
				return this.#sourceOf(uri);
			});
		}
	}

	/** Files dropped from the Explorer or an editor tab: their addresses, or (some drags) plain paths. */
	#attachUris(values: unknown): void {
		if (!Array.isArray(values)) return;
		for (const value of values) {
			if (typeof value === "string" && value.trim()) void this.#attach(() => this.#sourceOf(toUri(value.trim())));
		}
	}

	/**
	 * Read the file and add it to the input's attachments; one that can't be attached is reported in the chat.
	 * Files are attached one after another, so their chips keep the order they came in and share the text budget right.
	 */
	#attach(read: () => Promise<AttachmentSource>): Promise<void> {
		this.#attaching = this.#attaching
			.then(() => this.#attachNow(read))
			.catch(error => this.log(`attaching a file failed: ${errorText(error)}`)); // the next file is still attached
		return this.#attaching;
	}

	async #attachNow(read: () => Promise<AttachmentSource>): Promise<void> {
		if (this.#disposed) return;
		let source: AttachmentSource;
		try {
			source = await read();
		} catch (error) {
			if (!this.#disposed) this.#notice("warning", `Could not attach a file: ${errorText(error)}`);
			return;
		}
		if (this.#disposed) return;
		let tokensLeft = this.#textTokenBudget();
		for (const draft of this.#drafts.values()) tokensLeft -= draft.tokens ?? 0; // the message's text attachments share one budget
		const id = `a${nextAttachmentId++}`;
		let attachment = prepareAttachment(id, source, tokensLeft);
		if ("error" in attachment && attachment.needsPath && (source.bytes || source.text !== undefined)) {
			// No location (pasted, dropped from outside VS Code, or an untitled editor), and it can only go as a path: saved where omp can read it.
			const bytes = source.bytes ?? Buffer.from(source.text ?? "");
			try {
				const saved = prepareAttachment(id, { ...source, path: await this.#saveCopy(id, source.name, bytes) }, tokensLeft);
				attachment = "error" in saved ? saved : { ...saved, savedCopy: true };
			} catch (error) {
				if (!this.#disposed) this.#notice("warning", `Could not attach ${source.name}: saving a copy for omp failed (${errorText(error)}).`);
				return;
			}
		}
		if ("error" in attachment) {
			this.#notice("warning", attachment.error);
			return;
		}
		this.#drafts.set(attachment.id, attachment);
		this.chat.notify({ type: "attached", attachment: attachedChipOf(attachment) });
	}

	/** How many tokens of text one message may attach now. */
	#textTokenBudget(): number {
		return textTokenBudget(this.#context, vscode.workspace.getConfiguration("omp").get<number>("attachments.maxTextTokens", 0));
	}

	/**
	 * The attachments, with the text that no longer fits the budget sent as its path instead (a copy
	 * saved for text with no file of its own). Queued messages' files were each measured alone, and
	 * the context may have filled since they were attached.
	 */
	async #withinTextBudget(attachments: Attachment[]): Promise<Attachment[]> {
		let tokensLeft = this.#textTokenBudget();
		const fitted: Attachment[] = [];
		for (const attachment of attachments) {
			const tokens = attachment.tokens ?? 0;
			if (attachment.kind !== "text" || tokens <= tokensLeft) {
				tokensLeft -= tokens;
				fitted.push(attachment);
				continue;
			}
			try {
				const path = attachment.path ?? (await this.#saveCopy(attachment.id, attachment.name, Buffer.from(attachment.text ?? "")));
				const asPath = prepareAttachment(attachment.id, { name: attachment.name, path, text: attachment.text }, tokensLeft);
				fitted.push("error" in asPath ? attachment : { ...asPath, savedCopy: !attachment.path });
			} catch (error) {
				this.log(`sending ${attachment.name}'s text over the budget: saving a copy for omp failed (${errorText(error)})`);
				fitted.push(attachment);
			}
		}
		return fitted;
	}

	/** Save a file that has no location of its own where omp can read it, until the chat closes. */
	async #saveCopy(id: string, name: string, bytes: Uint8Array): Promise<string> {
		if (this.#disposed) throw new Error("the chat is closed");
		const copy = join(this.copiesDir, id, safeFileName(name));
		// Only this user may open them: pasted screenshots and text can be private.
		await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
		await writeFile(copy, bytes, { mode: 0o600 });
		if (this.#disposed) {
			// Closed while saving: dispose() may have removed the folder before this copy was written.
			await rm(this.copiesDir, { recursive: true, force: true });
			throw new Error("the chat is closed");
		}
		return copy;
	}

	/** A file to attach: an open editor's text (unsaved changes included), else what is on disk. */
	async #sourceOf(uri: vscode.Uri): Promise<AttachmentSource> {
		const name = posix.basename(uri.path) || uri.toString();
		const path = uri.scheme === "file" ? promptPath(uri) : undefined;
		const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
		if (open) return { name, path, text: open.getText() };
		const stat = await vscode.workspace.fs.stat(uri);
		if (stat.type & vscode.FileType.Directory) return { name, path, folder: true };
		if (stat.size > MAX_READ_BYTES) return { name, path, size: stat.size };
		return { name, path, bytes: await vscode.workspace.fs.readFile(uri) };
	}

	/**
	 * Send a message once the files and folders it mentions (@path) are attached. Each message waits
	 * for the one before it, so a second one sent quickly never overtakes the first.
	 */
	#sendWithMentions(text: string, attachments: Attachment[]): void {
		// No mention to read: sent at once, so it is queued (or started) before anything the page sends next.
		if (this.#mentionsPending === 0 && (isSlashCommand(text) || mentionsIn(text).length === 0)) {
			void this.send(text, attachments);
			return;
		}
		this.#mentionsPending++;
		this.#resolvingMentions = this.#resolvingMentions
			.then(() =>
				this.#mentioned(text, attachments).catch(error => {
					this.log(`attaching the files a message mentions failed: ${errorText(error)}`);
					return [];
				}),
			)
			.then(mentioned => {
				this.#mentionsPending--;
				if (!this.#disposed) void this.send(text, [...attachments, ...mentioned]);
			})
			.catch(error => this.log(`sending a message that mentions files failed: ${errorText(error)}`)); // later messages still go
	}

	/** Stop pressed on the page: after the messages sent before it, as for those still waiting for thumbnails there. */
	#cancelFromPage(): void {
		if (this.#mentionsPending === 0) this.cancel();
		else this.#resolvingMentions = this.#resolvingMentions.then(() => this.cancel()).catch(error => this.log(`stopping failed: ${errorText(error)}`));
	}

	/**
	 * The files and folders the message mentions that exist as typed, letter case included (relative
	 * to the project folder, or absolute), each attached once and not again if already attached. A
	 * folder goes as a reference, for omp to look in. A mention of anything else is left as text.
	 */
	async #mentioned(text: string, attached: readonly Attachment[]): Promise<Attachment[]> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root || isSlashCommand(text)) return []; // a slash command takes no attachments (see send() in media/chat.js)
		const taken = new Set(attached.map(attachment => attachment.path).filter(Boolean));
		let tokensLeft = this.#textTokenBudget() - attached.reduce((sum, attachment) => sum + (attachment.tokens ?? 0), 0);
		const found: Attachment[] = [];
		for (const spellings of mentionsIn(text)) {
			for (const spelling of spellings) {
				const local = localPath(root, spelling);
				if (!(await existsAsTyped(root, local))) continue; // try the next spelling, or leave the mention as text
				const uri = vscode.Uri.file(local);
				let source: AttachmentSource;
				try {
					source = await this.#sourceOf(uri);
				} catch {
					continue; // no such file: try the next spelling, or leave the mention as text
				}
				if (source.path && !taken.has(source.path)) {
					taken.add(source.path);
					const attachment = prepareAttachment(`a${nextAttachmentId++}`, source, tokensLeft);
					if ("error" in attachment) {
						this.#notice("warning", attachment.error);
					} else {
						tokensLeft -= attachment.tokens ?? 0;
						found.push(attachment);
					}
				}
				break;
			}
		}
		return found;
	}

	/**
	 * Answer the page's @ suggestions, completing what is typed like a path: the entries of the
	 * folder typed so far (the project folder when none is) whose names start with the rest; for a
	 * name with no folder, then also the project's files and folders further down that match it.
	 */
	async #findMentions(id: unknown, query: string): Promise<void> {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		// Always answered, if only with nothing, so the page drops the rows it shows for what was typed before.
		if (!root) return this.chat.notify({ type: "mentions", id, items: [] });
		try {
			const { folder, name } = splitMentionQuery(query);
			let items: MentionItem[] = completeInFolder(await folderEntries(localPath(root, folder || ".")), folder, name);
			if (!folder && name) {
				const shown = new Set(items.map(item => item.path));
				const elsewhere = rankMentions(await this.#workspaceFiles(), name).filter(item => !shown.has(item.path));
				items = [...items, ...elsewhere].slice(0, 12);
			}
			this.chat.notify({ type: "mentions", id, items });
		} catch (error) {
			this.log(`listing files for @ suggestions failed: ${errorText(error)}`);
			this.chat.notify({ type: "mentions", id, items: [] });
		}
	}

	/**
	 * The project's files, relative to its folder; listed again once the last list is a few seconds old.
	 * In a git repository, the files git sees, so what it ignores (.venv, build output…) stays out, which
	 * VS Code's file search can't do; elsewhere, what that search finds.
	 */
	#workspaceFiles(): Promise<string[]> {
		if (!this.#fileList || Date.now() - this.#fileList.at > FILE_LIST_TTL_MS) {
			const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			const files = (root ? gitFiles(root) : Promise.reject(new Error("no folder open"))).catch(() =>
				Promise.resolve(vscode.workspace.findFiles("**/*", excludeGlob(), MAX_MENTION_FILES)).then(uris => uris.map(promptPath)),
			);
			const list = { at: Date.now(), files };
			this.#fileList = list;
			files.catch(() => {
				if (this.#fileList === list) this.#fileList = undefined; // listed again next time
			});
		}
		return this.#fileList.files;
	}

	#unqueue(id: string): void {
		const message = this.#queue.find(queued => queued.id === id);
		if (message) this.#dequeue([message]);
	}

	/** Start omp ahead of the first message, so the chat shows Ready and the model settings. */
	async start(): Promise<void> {
		try {
			await this.#ensureAgent();
		} catch (error) {
			this.#notice("error", errorText(error));
		}
	}

	/** Post a notice, dropping an exact repeat of the previous one (e.g. an exit reported twice). */
	#notice(level: "info" | "warning" | "error", text: string): void {
		if (text === this.#lastNotice) return;
		this.#lastNotice = text;
		this.chat.post({ type: "notice", level, text });
	}

	dispose(): void {
		this.#disposed = true;
		this.#queue = [];
		this.#stopAgent("Chat closed");
		void rm(this.copiesDir, { recursive: true, force: true }).catch(() => {});
		for (const disposable of this.#disposables) disposable.dispose();
	}

	// ---- agent lifecycle -------------------------------------------------------

	#ensureAgent(): Promise<OmpAgent> {
		// Startup is over only once a loaded chat has been named, so a message never races the naming.
		if (this.#starting) return this.#starting;
		if (this.#agent?.sessionId) return Promise.resolve(this.#agent);
		const starting = this.#startAgent().finally(() => {
			if (this.#starting === starting) this.#starting = undefined;
		});
		this.#starting = starting;
		return starting;
	}

	async #startAgent(): Promise<OmpAgent> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (!folder) throw new Error("Open a folder first: omp works inside a project folder.");
		const config = vscode.workspace.getConfiguration("omp");
		const args = [...config.get<string[]>("extraArgs", [])];
		if (config.get<boolean>("preferEditTool", true)) args.push("--append-system-prompt", PREFER_EDIT_TOOL_PROMPT);
		const mcp = config.get<boolean>("useMcpServers", true)
			? loadMcpServers(mcpConfigFiles(folder.uri.fsPath, vscode.workspace.isTrusted))
			: { servers: [], problems: [] };
		for (const problem of mcp.problems) this.#notice("warning", problem);

		this.chat.post({ type: "status", state: "starting" });
		const command = resolveOmpCommand(config.get<string>("path", "omp"));
		// Checked while omp starts, once per tab (a new session after `bun upgrade` checks again). Posted
		// directly: through #notice it would arrive between startup notices and upset their repeat check.
		void bunVersion(command).then(version => {
			const problem = version && bunCertificateProblem(version);
			if (!problem || this.#disposed || this.#warnedAboutBun) return;
			this.#warnedAboutBun = true;
			this.chat.post({ type: "notice", level: "warning", text: problem });
		});
		const agent = new OmpAgent({
			command,
			args,
			cwd: folder.uri.fsPath,
			mcpServers: addSavedLogins(mcp.servers, ompSavedToken(command)), // looked up while omp starts
			handlers: {
				readTextFile: params => this.#readTextFile(params),
				writeTextFile: params => this.#writeTextFile(params),
				requestPermission: params => this.#requestPermission(params),
				elicit: params => this.#elicit(params),
				onSessionUpdate: update => this.#onSessionUpdate(update),
				onExit: message => this.#onAgentExit(agent, message),
				log: this.log,
			},
		});
		this.#agent = agent;
		this.#context = undefined; // a new session's context (or a saved one's) is reported afresh
		const loadSessionId = this.resumeSessionId;
		if (!loadSessionId) this.#forgetTitle(); // a fresh session (e.g. after omp exited) is a new, unnamed chat
		this.#loadingSessionId = loadSessionId;
		try {
			const session = await agent.start(loadSessionId, { replay: loadSessionId !== this.#shownSessionId });
			this.#loadingSessionId = undefined;
			this.resumeSessionId = undefined;
			this.#shownSessionId = session.sessionId;
			this.log(`omp session ${session.sessionId} started in ${folder.uri.fsPath}`);
			if (mcp.servers.length > 0) this.log(`MCP servers passed to omp: ${mcp.servers.map(server => server.name).join(", ")}`);
			for (const problem of agent.mcpProblems) {
				const signIn = /\b401\b/.test(problem) ? " To sign in once, run `omp` in a terminal, then `/mcp reauth <server name>`." : "";
				this.#notice("warning", problem + signIn);
			}
			this.chat.post({ type: "config", options: agent.configOptions });
			if (loadSessionId && this.nameOnLoad) await this.#nameIfUntitled(agent); // an old chat that never got a name
			if (this.#agent !== agent) {
				// omp exited (and said so) while naming the chat: the next start loads the saved chat again.
				this.resumeSessionId = loadSessionId;
				throw new Error("omp stopped while opening this chat. Send your message again to retry.");
			}
			this.chat.post({ type: "status", state: this.#busy ? "busy" : "idle" });
			return agent;
		} catch (error) {
			this.#loadingSessionId = undefined;
			agent.dispose();
			if (this.#agent === agent) {
				this.#agent = undefined;
				this.chat.post({ type: "status", state: "stopped" });
			}
			if (loadSessionId && error instanceof AgentError && /session not found/i.test(error.message)) {
				// omp no longer has the saved chat (e.g. deleted since it was listed): trying it again would fail the same way.
				this.resumeSessionId = undefined;
				throw new Error(`omp could not open this saved chat (${errorText(error)}). Your next message starts a new chat.`);
			}
			throw error;
		}
	}

	#forgetTitle(): void {
		this.#namingAttempts = 0;
		if (this.chat.chatTitle !== undefined) this.chat.setChatTitle(undefined); // also a saved chat's name, set by the tab
	}

	#stopAgent(reason: string): void {
		this.#cancelPending(reason);
		const agent = this.#agent;
		this.#agent = undefined;
		this.#starting = undefined;
		agent?.dispose();
	}

	#onAgentExit(agent: OmpAgent, message: string): void {
		if (this.#agent !== agent) return;
		this.#agent = undefined;
		this.#cancelPending(message);
		this.#notice("error", message);
		this.chat.post({ type: "status", state: "stopped" });
	}

	#cancelPending(reason: string): void {
		this.reviews.cancelAll(this.id, reason);
		for (const [requestId, pending] of this.#pending) {
			pending.resolve(pending.cancelValue);
			this.chat.post({ type: "resolved", requestId, label: "Cancelled" });
		}
		this.#pending.clear();
	}

	// ---- chat panel ---------------------------------------------------------------

	#onChatMessage(message: any): void {
		switch (message?.type) {
			case "send": {
				const text = typeof message.text === "string" ? message.text.trim() : "";
				const attachments = this.#takeDrafts(message.attachments);
				if (text || attachments.length > 0) this.#sendWithMentions(text, attachments);
				break;
			}
			case "findMentions":
				if (typeof message.query === "string") void this.#findMentions(message.id, message.query);
				break;
			case "ready":
				this.#drafts.clear(); // a page that (re)loads starts with an empty input
				break;
			case "pickFiles":
				void this.#pickFiles();
				break;
			case "attachUris":
				this.#attachUris(message.uris);
				break;
			case "attachData":
				// Pasted, or dropped from outside VS Code: the page read the file, but its location is unknown.
				if (typeof message.name === "string" && typeof message.data === "string") {
					const bytes = Buffer.from(message.data, "base64");
					void this.#attach(async () => ({ name: message.name, bytes }));
				}
				break;
			case "detach":
				this.#drafts.delete(message.id);
				break;
			case "thumbnail": {
				// The page's small copy of an attached image, for the chips of the message it goes with.
				const attachment = this.#drafts.get(message.id) ?? this.#queue.flatMap(queued => queued.attachments).find(queued => queued.id === message.id);
				if (attachment?.kind === "image" && isChipThumbnail(message.data)) attachment.thumbnail = message.data;
				break;
			}
			case "cancel":
				this.#cancelFromPage();
				break;
			case "unqueue":
				this.#unqueue(message.id);
				break;
			case "respond": {
				const pending = this.#pending.get(message.requestId);
				if (!pending) return;
				this.#pending.delete(message.requestId);
				// Ticked on a command's card: its read-only programs are allowed from now on, whatever this one's answer.
				if (message.allowReadOnly === true) pending.allowReadOnly?.();
				pending.resolve(message.value);
				this.chat.post({ type: "resolved", requestId: message.requestId, label: message.label });
				const note = typeof message.note === "string" ? message.note.trim() : "";
				const changed = typeof message.changedCommand === "string" && message.changedCommand.trim() ? message.changedCommand.trim() : undefined;
				if (note || changed) pending.rejectNote?.(note, changed);
				break;
			}
			case "openReview":
				void this.reviews.open(message.reviewId);
				break;
			case "setConfig":
				void this.#setConfig(message.configId, message.value);
				break;
		}
	}

	/** Show a card in the chat and wait for the user's answer; `extras` run on what else the card sends with it. */
	#ask<T>(card: Record<string, unknown>, cancelValue: T, extras: Pick<PendingRequest, "allowReadOnly" | "rejectNote"> = {}): Promise<T> {
		const requestId = String(nextRequestId++);
		this.chat.requestAttention();
		return new Promise<T>(resolve => {
			this.#pending.set(requestId, { resolve, cancelValue, ...extras });
			this.chat.post({ ...card, requestId });
		});
	}

	async #setConfig(configId: string, value: string): Promise<void> {
		try {
			const agent = await this.#ensureAgent();
			const options = await agent.setConfigOption(configId, value);
			this.chat.post({ type: "config", options });
		} catch (error) {
			this.#notice("error", errorText(error));
		}
	}

	// ---- ACP client handlers --------------------------------------------------

	#onSessionUpdate(update: SessionUpdate): void {
		// Part of the saved chat is on screen from its first replayed message, so a load that fails
		// partway and is retried must not replay it again below the part already shown.
		if (this.#loadingSessionId && REPLAYED_UPDATES.has(update.sessionUpdate)) this.#shownSessionId = this.#loadingSessionId;
		if (update.sessionUpdate === "config_option_update") {
			this.chat.post({ type: "config", options: update.configOptions });
			return;
		}
		if (update.sessionUpdate === "session_info_update") {
			if (typeof update.title === "string" && update.title.trim()) {
				this.chat.setChatTitle(update.title.trim());
			}
			return;
		}
		if (update.sessionUpdate === "usage_update" && typeof update.used === "number" && typeof update.size === "number" && update.size > 0) {
			this.#context = { used: update.used, size: update.size };
		}
		if (this.#naming && update.sessionUpdate === "agent_message_chunk") return; // omp's "Session renamed to …"
		if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
			const code = codeOfToolInput(update.rawInput);
			if (update.status === "completed" || update.status === "failed") this.#runningCode.delete(update.toolCallId);
			else if (code) this.#runningCode.set(update.toolCallId, code);
		}
		this.chat.post({ type: "update", update });
	}

	async #readTextFile(params: ReadTextFileParams): Promise<string> {
		// Missing file: read again from disk so omp gets the real "not found" error.
		const text = (await this.#currentText(vscode.Uri.file(params.path))) ?? (await readFile(params.path, "utf8"));
		if (params.line === undefined && params.limit === undefined) return text;
		const lines = text.split(/(?<=\n)/);
		const start = Math.max((params.line ?? 1) - 1, 0);
		const end = params.limit === undefined ? undefined : start + params.limit;
		return lines.slice(start, end).join("");
	}

	async #writeTextFile(params: WriteTextFileParams): Promise<void> {
		const uri = vscode.Uri.file(params.path);
		const displayPath = vscode.workspace.asRelativePath(uri);
		const current = await this.#currentText(uri);
		const original = current ?? "";
		if (current === params.content) return;
		if (current === undefined && params.content === "") {
			await saveText(uri, "", false); // empty new file: nothing to review
			return;
		}

		const outcome = await this.reviews.review(this.id, uri, displayPath, original, params.content);
		if ((await this.#currentText(uri)) !== current) {
			this.#notice("warning", `${displayPath} changed during the review, so omp's change was not saved.`);
			throw new RpcError(-32000, staleFileMessage(displayPath));
		}
		if (outcome.accepted.some(Boolean)) {
			await saveText(uri, applyDecisions(outcome.diff, outcome.accepted), current !== undefined);
		}
		if (outcome.accepted.every(Boolean)) return;
		throw new RpcError(-32000, rejectionMessage(displayPath, outcome.diff.hunks, outcome.accepted, outcome.notes));
	}

	/** Current file text, preferring unsaved editor content; undefined if the file does not exist. */
	async #currentText(uri: vscode.Uri): Promise<string | undefined> {
		const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
		if (open) return open.getText();
		try {
			return await readFile(uri.fsPath, "utf8");
		} catch {
			return undefined;
		}
	}

	async #requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult> {
		const command: string | undefined =
			typeof params.toolCall.rawInput?.command === "string" ? params.toolCall.rawInput.command : undefined;
		const allowOnce = params.options.find(option => option.kind === "allow_once");
		const parts = command !== undefined && allowOnce !== undefined ? commandParts(command) : undefined;
		const readOnly = parts !== undefined && parts.every(part => part.readOnly);
		// omp's shell can run a command in another folder (its `cwd` option) instead of using `cd`.
		const cwd = typeof params.toolCall.rawInput?.cwd === "string" ? params.toolCall.rawInput.cwd : undefined;
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const scope = readOnly && folder !== undefined ? readScope(command!, folder, cwd) : undefined;
		// A secret (a key, token or password file) is read only when asked, every time.
		const sensitive = scope?.sensitive ?? false;
		if (readOnly && !sensitive) {
			const config = vscode.workspace.getConfiguration("omp");
			const inFolder = scope?.inside === true && config.get<boolean>("autoAllowReadsInFolder", true);
			if (inFolder || parts.every(part => this.#allowedReadOnly.has(part.name))) {
				const names = [...new Set(parts.map(part => part.name))];
				this.log(`auto-allowed a read-only command${inFolder ? " inside the folder" : ""}: ${command}`);
				this.chat.post({ type: "autoAllowed", toolCallId: params.toolCall.toolCallId, names, inFolder });
				return { outcome: { outcome: "selected", optionId: allowOnce!.optionId } };
			}
		}
		// The read-only programs in this command not allowed yet, which "always allow" would add.
		const toAllow = [...new Set((parts ?? []).filter(part => part.readOnly && !this.#allowedReadOnly.has(part.name)).map(part => part.name))];
		const allowThem = () => {
			for (const name of toAllow) this.#allowedReadOnly.add(name);
		};

		// omp's own "always" answers cover every later shell command in the session: "always allow"
		// would let writes through and "always reject" would silently refuse even `ls`. Neither is
		// offered for commands. Instead, "always" covers the read-only programs this command runs: a
		// button on a read-only command, and on any other a checkbox that leaves this one's answer to the user.
		const options: (PermissionOption & { description?: string })[] = [];
		for (const option of params.options) {
			if (command !== undefined && (option.kind === "allow_always" || option.kind === "reject_always")) continue;
			options.push(option);
			// Not on a command that reads a secret: those ask every time.
			if (readOnly && !sensitive && toAllow.length > 0 && option === allowOnce) {
				options.push({
					optionId: ALLOW_READ_ONLY,
					name: `Always allow ${toAllow.join(", ")}`,
					kind: "allow_always",
					description: `Allow this, and later commands in this chat made only of ${[...this.#allowedReadOnly, ...toAllow].join(", ")}, when they only read, in any folder. Any other program, an option that writes or runs one, or a secret (.env, keys, ~/.ssh, …) still asks.`,
				});
			}
		}
		const warn = vscode.workspace.getConfiguration("omp").get<boolean>("warnOnShellFileChanges", true);
		const optionId = await this.#ask<string | undefined>(
			{
				type: "permission",
				toolCallId: params.toolCall.toolCallId,
				title: params.toolCall.title ?? "omp wants to run a tool",
				kind: params.toolCall.kind,
				command,
				cwd,
				warning: sensitive
					? "This command reads a secret (a key, token or password file), so it asks every time."
					: command && warn
						? fileChangeWarning(command)
						: undefined,
				locations: params.toolCall.locations?.map(l => l.path),
				options,
				// The checkbox: the read-only programs to allow from now on, whatever this command's answer.
				offerReadOnly: !readOnly && toAllow.length > 0 ? toAllow : undefined,
			},
			undefined,
			{
				allowReadOnly: allowThem,
				// omp tells the model only "rejected by user", and takes no message during a turn: so the turn
				// stops, and the note follows as the next message (queued until the stopped turn ends).
				rejectNote: (note, changed) => {
					const text = rejectedCommandMessage({ command, title: params.toolCall.title }, note, command !== undefined ? changed : undefined);
					this.log("a command was rejected with a note: stopping the turn to send it");
					this.cancel();
					void this.send(text);
				},
			},
		);
		if (optionId === ALLOW_READ_ONLY) {
			allowThem();
			return { outcome: { outcome: "selected", optionId: allowOnce!.optionId } };
		}
		return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
	}

	async #elicit(params: ElicitationParams): Promise<ElicitationResult> {
		if (params.mode === "url") {
			// Not advertised in clientCapabilities; opening an agent-chosen URL unasked is unsafe.
			this.log(`declined a request to open ${params.url}`);
			return { action: "decline" };
		}
		const properties = params.requestedSchema?.properties ?? {};
		const approval = parseApprovalMessage(params.message);
		const isApproveDeny = properties.value?.enum?.includes("Approve") && properties.value.enum.includes("Deny");

		if (approval && isApproveDeny) {
			const config = vscode.workspace.getConfiguration("omp");
			if (DIFF_REVIEWED_TOOLS.has(approval.toolName) && config.get<boolean>("autoApproveEditPrompts", true)) {
				this.log(`auto-approved ${approval.toolName} (the diff review comes next): ${approval.details}`);
				return { action: "accept", content: { value: "Approve" } };
			}
			const warn = config.get<boolean>("warnOnShellFileChanges", true) && approval.toolName === "bash";
			// omp's browser prompt names no page, so show the code that asked, but only when
			// exactly one running code step uses the browser: a guess could show the wrong page.
			const candidates: string[] = [];
			if (approval.toolName === "browser") {
				for (const running of this.#runningCode.values()) {
					if (/\bbrowser\b/.test(running)) candidates.push(running);
				}
			}
			const code = candidates.length === 1 ? candidates[0] : undefined;
			const found = code ? urlsIn(code) : undefined;
			const choice = await this.#ask<string | undefined>(
				{
					type: "approval",
					toolName: approval.toolName,
					details: approval.details,
					warning: warn ? fileChangeWarning(approval.details) : undefined,
					code,
					urls: found?.urls,
					someUrlsHidden: found?.someHidden,
					unclear: candidates.length > 1,
				},
				undefined,
			);
			return choice ? { action: "accept", content: { value: choice } } : { action: "cancel" };
		}

		const content = await this.#ask<Record<string, any> | undefined>(
			{ type: "question", message: params.message, schema: params.requestedSchema },
			undefined,
		);
		return content ? { action: "accept", content } : { action: "decline" };
	}
}

async function saveText(uri: vscode.Uri, text: string, exists: boolean): Promise<void> {
	if (!exists) {
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
		await vscode.workspace.fs.writeFile(uri, Buffer.from(text, "utf8"));
		return;
	}
	const document = await vscode.workspace.openTextDocument(uri);
	const edit = new vscode.WorkspaceEdit();
	edit.replace(uri, document.validateRange(new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0)), text);
	if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused to edit ${uri.fsPath}`);
	await document.save();
}

/** The display name of the model omp is using, from its "model" setting. */
function currentModelName(options: ConfigOption[]): string | undefined {
	const model = options.find(option => option.category === "model" || option.id === "model");
	return model?.options.find(choice => choice.value === model.currentValue)?.name;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Queued messages' texts as one message. */
function joinTexts(messages: QueuedMessage[]): string {
	return messages
		.map(message => message.text)
		.filter(Boolean)
		.join("\n\n");
}

/** A file name from the chat page, safe as one file in a folder of ours. */
function safeFileName(name: string): string {
	const base = posix.basename(name.replace(/\\/g, "/")).replace(/[\0-\x1f<>:"|?*]/g, "_");
	return base && base !== "." && base !== ".." ? base : "attachment";
}

/**
 * What file searches leave out: what VS Code's search leaves out (files.exclude, search.exclude),
 * and dependencies and git's own files. A pattern given to findFiles replaces files.exclude, so it is
 * included here; patterns that would break the {a,b} group are skipped.
 */
function excludeGlob(): string {
	const patterns = new Set(["**/node_modules", "**/.git"]);
	for (const setting of ["files.exclude", "search.exclude"]) {
		const excluded = vscode.workspace.getConfiguration().get<Record<string, unknown>>(setting) ?? {};
		for (const [pattern, on] of Object.entries(excluded)) {
			if (on === true && !/[{},]/.test(pattern)) patterns.add(pattern);
		}
	}
	return `{${[...patterns].join(",")}}`;
}

/** A slash command for omp: "/word" (a path, "/Users/…", has more slashes), as send() in media/chat.js tells them apart. */
function isSlashCommand(text: string): boolean {
	return /^\/[^\s/]+(?:\s|$)/.test(text);
}

/**
 * The files git sees in a folder (tracked, and new ones it doesn't ignore), relative to it, a
 * submodule with a trailing slash, as a folder; fails outside a git repository.
 */
async function gitFiles(folder: string): Promise<string[]> {
	const [tracked, untracked] = await Promise.all([
		git(folder, ["ls-files", "--stage", "-z"]), // with each one's mode, which tells a submodule apart
		git(folder, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	// A file with a merge conflict is listed once for each side.
	return [...new Set([...gitStagePaths(tracked), ...untracked.split("\0").filter(Boolean)])].slice(0, MAX_MENTION_FILES);
}

function git(folder: string, args: string[]): Promise<string> {
	return new Promise((done, fail) => {
		execFile("git", args, { cwd: folder, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => (error ? fail(error) : done(stdout)));
	});
}

/**
 * The path exists as typed, letter case included: macOS and Windows find a folder named "test" for
 * "Test" too, which would make a pasted @Test decorator a mention. Only the part typed is compared,
 * and only a difference of case fails (a link may lead somewhere else altogether).
 */
async function existsAsTyped(root: string, path: string): Promise<boolean> {
	let real: string;
	try {
		real = await realpath(path);
	} catch {
		return false;
	}
	const inside = relative(root, path);
	if (!inside) return true; // the project folder itself
	const typed = (inside.startsWith("..") || isAbsolute(inside) ? path : inside).split(/[\\/]/).filter(Boolean);
	const found = real.split(/[\\/]/).filter(Boolean).slice(-typed.length);
	return typed.every((part, i) => part === found[i] || part.toLowerCase() !== found[i]?.toLowerCase());
}

/** A path typed in a message (relative to the project folder, absolute, or under ~) on this machine. */
function localPath(root: string, typed: string): string {
	return resolve(root, typed.replace(/^~(?=\/|$)/, homedir()));
}

/** A folder's entries (a link to a folder counts as one); none when it can't be read, e.g. a folder still being typed. */
async function folderEntries(path: string): Promise<{ name: string; folder: boolean }[]> {
	try {
		const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
		return entries.map(([name, type]) => ({ name, folder: (type & vscode.FileType.Directory) !== 0 }));
	} catch {
		return [];
	}
}

/** A dropped address (file:///…, untitled:…) or a plain path (/…, C:\…). */
function toUri(value: string): vscode.Uri {
	// A scheme has two letters or more, so a Windows drive (C:) is a path.
	return /^[a-z][\w+.-]+:/i.test(value) ? vscode.Uri.parse(value, true) : vscode.Uri.file(value);
}

/** The path omp is given for a file: relative to the folder omp runs in when inside it, else absolute. */
function promptPath(uri: vscode.Uri): string {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) return uri.fsPath;
	const inside = relative(folder.uri.fsPath, uri.fsPath);
	const outside = !inside || isAbsolute(inside) || inside === ".." || /^\.\.[\\/]/.test(inside);
	return outside ? uri.fsPath : inside.split("\\").join("/");
}

/** Runs `use` with a short-lived omp, started in `folder`, that can only list saved chats. */
export async function withListingOmp<T>(log: (line: string) => void, folder: string, use: (omp: OmpAgent) => Promise<T>): Promise<T> {
	const config = vscode.workspace.getConfiguration("omp");
	const refuse = async (): Promise<never> => {
		throw new RpcError(-32601, "not available while listing chats");
	};
	const agent = new OmpAgent({
		command: resolveOmpCommand(config.get<string>("path", "omp")),
		args: [...config.get<string[]>("extraArgs", [])],
		cwd: folder,
		handlers: {
			readTextFile: refuse,
			writeTextFile: refuse,
			requestPermission: refuse,
			elicit: refuse,
			onSessionUpdate: () => {},
			onExit: () => {},
			log,
		},
	});
	try {
		await agent.connect();
		return await use(agent);
	} finally {
		agent.dispose();
	}
}
