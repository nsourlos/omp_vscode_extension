/**
 * Glue between omp (ACP), the chat panel and the diff review.
 * Every permission/approval omp asks for becomes a card in the chat; every file
 * write becomes a hunk-by-hunk review before anything is saved.
 */
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { RpcError } from "./acp/rpc";
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
import { OmpAgent, ompSavedToken, resolveOmpCommand } from "./omp/agent";
import { addSavedLogins, loadMcpServers, mcpConfigFiles } from "./omp/mcp";
import {
	DIFF_REVIEWED_TOOLS,
	PREFER_EDIT_TOOL_PROMPT,
	codeOfToolInput,
	fileChangeWarning,
	isReadOnlyCommand,
	parseApprovalMessage,
	rejectionMessage,
	staleFileMessage,
	urlsIn,
} from "./omp/policy";
import { applyDecisions } from "./review/hunks";
import type { ReviewManager } from "./review/reviewManager";

interface PendingRequest {
	resolve: (value: any) => void;
	cancelValue: unknown;
}

interface QueuedMessage {
	id: string;
	text: string;
}

/** How many replies may be followed by an attempt to name an untitled chat. */
const MAX_NAMING_ATTEMPTS = 3;

/** The extension's own permission option; answered to omp as "allow once". */
const ALLOW_READ_ONLY = "omp-vscode:allow-read-only";

let nextRequestId = 1;
let nextQueuedId = 1;
let nextControllerId = 1;

/** Runs one chat session: its own omp process, cards and review queue. */
export class Controller implements vscode.Disposable {
	readonly id = String(nextControllerId++);
	#agent: OmpAgent | undefined;
	#starting: Promise<OmpAgent> | undefined;
	#pending = new Map<string, PendingRequest>();
	#busy = false;
	#stopRequested = false;
	/** Set by "Always allow read-only commands"; lasts as long as this chat tab. */
	#allowReadOnly = false;
	#disposed = false;
	/** The chat's name from omp, once it has one. */
	#title: string | undefined;
	#namingAttempts = 0;
	/** True while omp is naming the chat, so its reply is not shown. */
	#naming = false;
	/** Code of the tool calls still running (eval), so a bare "Allow tool: browser" can show what it will do. */
	#runningCode = new Map<string, string>();
	#queue: QueuedMessage[] = [];
	#lastNotice: string | undefined;
	#disposables: vscode.Disposable[] = [];

	constructor(
		private readonly chat: ChatPanel,
		private readonly reviews: ReviewManager,
		private readonly log: (line: string) => void,
		/** A saved chat to load on first start; after that (e.g. a restart after a crash) a fresh one opens. */
		private resumeSessionId?: string,
		/** The saved chat has no name yet: name it once it has loaded. */
		private readonly nameOnLoad = false,
	) {
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
	async send(text: string): Promise<void> {
		if (this.#busy) {
			const id = String(nextQueuedId++);
			this.#queue.push({ id, text });
			this.chat.post({ type: "queued", id, text });
			return;
		}
		this.#busy = true;
		this.#stopRequested = false;
		this.#lastNotice = undefined;
		this.#runningCode.clear();
		this.chat.post({ type: "user", text });
		this.chat.post({ type: "status", state: "busy" });
		let agent: OmpAgent | undefined;
		let finished = false;
		try {
			agent = await this.#ensureAgent();
			const started = Date.now();
			// omp ignores a cancel before its session exists, so a Stop pressed during startup is applied here.
			const result = this.#stopRequested ? { stopReason: "cancelled" as const } : await agent.prompt(text);
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
		if ((finished || this.#stopRequested) && this.#queue.length > 0) {
			const next = this.#takeNextTurn();
			return this.send(next.map(message => message.text).join("\n\n"));
		}
		this.#returnQueueToInput();
		this.chat.markFinished();
		if (finished && vscode.workspace.getConfiguration("omp").get<boolean>("soundOnFinish", true)) {
			this.chat.notify({ type: "chime" });
		}
		if (!finished || !this.#agent) return;
		this.#busy = true; // a message sent while the chat is being named waits in the queue
		await this.#nameIfUntitled(this.#agent);
		this.#busy = false;
		if (this.#queue.length > 0) return this.send(this.#takeNextTurn().map(message => message.text).join("\n\n"));
	}

	/**
	 * omp names chats only in its terminal app, so the extension asks it to after a reply, until it has a name:
	 * `/rename` with no title makes omp name the chat from the conversation. Its reply
	 * ("Session renamed to …") is kept out of the chat.
	 */
	async #nameIfUntitled(agent: OmpAgent): Promise<void> {
		// omp gives no name to a chat with nothing to name yet ("hi"), so it is asked again after later replies.
		if (this.#title || this.#namingAttempts >= MAX_NAMING_ATTEMPTS) return;
		this.#namingAttempts++;
		this.#naming = true;
		try {
			await agent.prompt("/rename");
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
		const isCommand = (message: QueuedMessage) => message.text.startsWith("/");
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

	#returnQueueToInput(): void {
		const queued = this.#takeQueue();
		if (queued.length > 0) this.chat.notify({ type: "restoreInput", text: queued.map(message => message.text).join("\n\n") });
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
		for (const disposable of this.#disposables) disposable.dispose();
	}

	// ---- agent lifecycle -------------------------------------------------------

	#ensureAgent(): Promise<OmpAgent> {
		if (this.#agent?.sessionId) return Promise.resolve(this.#agent);
		if (this.#starting) return this.#starting;
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
			? loadMcpServers(mcpConfigFiles(folder.uri.fsPath))
			: { servers: [], problems: [] };
		for (const problem of mcp.problems) this.#notice("warning", problem);

		this.chat.post({ type: "status", state: "starting" });
		const command = resolveOmpCommand(config.get<string>("path", "omp"));
		const mcpServers = await addSavedLogins(mcp.servers, ompSavedToken(command));
		if (this.#disposed) throw new Error("Chat closed"); // closed while looking up sign-ins: start no omp
		const agent = new OmpAgent({
			command,
			args,
			cwd: folder.uri.fsPath,
			mcpServers,
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
		try {
			const session = await agent.start(this.resumeSessionId);
			this.resumeSessionId = undefined;
			this.log(`omp session ${session.sessionId} started in ${folder.uri.fsPath}`);
			if (mcp.servers.length > 0) this.log(`MCP servers passed to omp: ${mcp.servers.map(server => server.name).join(", ")}`);
			for (const problem of agent.mcpProblems) {
				const signIn = /\b401\b/.test(problem) ? " To sign in once, run `omp` in a terminal, then `/mcp reauth <server name>`." : "";
				this.#notice("warning", problem + signIn);
			}
			this.chat.post({ type: "config", options: agent.configOptions });
			if (this.nameOnLoad) await this.#nameIfUntitled(agent); // an old chat that never got a name
			this.chat.post({ type: "status", state: this.#busy ? "busy" : "idle" });
			return agent;
		} catch (error) {
			agent.dispose();
			if (this.#agent === agent) {
				this.#agent = undefined;
				this.chat.post({ type: "status", state: "stopped" });
			}
			throw error;
		}
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
			case "send":
				if (typeof message.text === "string" && message.text.trim()) void this.send(message.text.trim());
				break;
			case "cancel":
				this.cancel();
				break;
			case "unqueue":
				this.#unqueue(message.id);
				break;
			case "respond": {
				const pending = this.#pending.get(message.requestId);
				if (!pending) return;
				this.#pending.delete(message.requestId);
				pending.resolve(message.value);
				this.chat.post({ type: "resolved", requestId: message.requestId, label: message.label });
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

	/** Show a card in the chat and wait for the user's answer. */
	#ask<T>(card: Record<string, unknown>, cancelValue: T): Promise<T> {
		const requestId = String(nextRequestId++);
		this.chat.requestAttention();
		return new Promise<T>(resolve => {
			this.#pending.set(requestId, { resolve, cancelValue });
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
		if (update.sessionUpdate === "config_option_update") {
			this.chat.post({ type: "config", options: update.configOptions });
			return;
		}
		if (update.sessionUpdate === "session_info_update") {
			if (typeof update.title === "string" && update.title.trim()) {
				this.#title = update.title.trim();
				this.chat.setChatTitle(this.#title);
			}
			return;
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
		const readOnly = command !== undefined && allowOnce !== undefined && isReadOnlyCommand(command);
		if (readOnly && this.#allowReadOnly) {
			this.log(`auto-allowed a read-only command: ${command}`);
			this.chat.post({ type: "autoAllowed", toolCallId: params.toolCall.toolCallId });
			return { outcome: { outcome: "selected", optionId: allowOnce.optionId } };
		}

		// omp's own "always" for a shell command allows every later command in the session, writes
		// included, so it is replaced by an "always" that covers read-only commands only.
		const options: (PermissionOption & { description?: string })[] = [];
		for (const option of params.options) {
			if (command !== undefined && option.kind === "allow_always") continue;
			options.push(option);
			if (readOnly && option === allowOnce) {
				options.push({
					optionId: ALLOW_READ_ONLY,
					name: "Always allow read-only commands",
					kind: "allow_always",
					description: "Allow this and later commands that only read or navigate (cd, ls, cat, grep, find, git log…) in this chat. Anything else still asks.",
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
				warning: command && warn ? fileChangeWarning(command) : undefined,
				locations: params.toolCall.locations?.map(l => l.path),
				options,
			},
			undefined,
		);
		if (optionId === ALLOW_READ_ONLY) {
			this.#allowReadOnly = true;
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

/** The chats omp has saved for the open folder, newest first, asked of a short-lived omp. */
export async function listSavedChats(log: (line: string) => void): Promise<SavedSession[]> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) throw new Error("Open a folder first: omp works inside a project folder.");
	const config = vscode.workspace.getConfiguration("omp");
	const refuse = async (): Promise<never> => {
		throw new RpcError(-32601, "not available while listing chats");
	};
	const agent = new OmpAgent({
		command: resolveOmpCommand(config.get<string>("path", "omp")),
		args: [...config.get<string[]>("extraArgs", [])],
		cwd: folder.uri.fsPath,
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
		return await agent.listSessions();
	} finally {
		agent.dispose();
	}
}
