/**
 * Glue between omp (ACP), the chat panel and the diff review.
 * Every permission/approval omp asks for becomes a card in the chat; every file
 * write becomes a hunk-by-hunk review before anything is saved.
 */
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { RpcError } from "./acp/rpc";
import type {
	ElicitationParams,
	ElicitationResult,
	ReadTextFileParams,
	RequestPermissionParams,
	RequestPermissionResult,
	SessionUpdate,
	WriteTextFileParams,
} from "./acp/types";
import type { ChatView } from "./chatView";
import { OmpAgent, resolveOmpCommand } from "./omp/agent";
import {
	DIFF_REVIEWED_TOOLS,
	PREFER_EDIT_TOOL_PROMPT,
	fileChangeWarning,
	parseApprovalMessage,
	rejectionMessage,
	staleFileMessage,
} from "./omp/policy";
import { applyDecisions } from "./review/hunks";
import type { ReviewManager } from "./review/reviewManager";

interface PendingRequest {
	resolve: (value: any) => void;
	cancelValue: unknown;
}

let nextRequestId = 1;

export class Controller implements vscode.Disposable {
	#agent: OmpAgent | undefined;
	#starting: Promise<OmpAgent> | undefined;
	#pending = new Map<string, PendingRequest>();
	#busy = false;
	#lastNotice: string | undefined;
	#disposables: vscode.Disposable[] = [];

	constructor(
		private readonly chat: ChatView,
		private readonly reviews: ReviewManager,
		private readonly output: vscode.OutputChannel,
	) {
		this.#disposables.push(
			chat.onMessage(message => this.#onChatMessage(message)),
			reviews.onDidChangeReview(info => chat.post({ type: "review", info })),
		);
	}

	async send(text: string): Promise<void> {
		if (this.#busy) {
			this.#notice("warning", "omp is still working. Press Stop first.");
			return;
		}
		this.#busy = true;
		this.#lastNotice = undefined;
		this.chat.post({ type: "user", text });
		this.chat.post({ type: "status", state: "busy" });
		try {
			const agent = await this.#ensureAgent();
			const result = await agent.prompt(text);
			this.chat.post({ type: "turnEnd", stopReason: result.stopReason });
		} catch (error) {
			this.#notice("error", errorText(error));
		} finally {
			this.#busy = false;
			this.chat.post({ type: "status", state: this.#agent ? "idle" : "stopped" });
		}
	}

	cancel(): void {
		this.#agent?.cancel();
		this.#cancelPending("Stopped by user");
	}

	async newSession(): Promise<void> {
		this.#stopAgent("New session started");
		this.chat.reset();
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
		this.#stopAgent("Extension shutting down");
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

		this.chat.post({ type: "status", state: "starting" });
		const agent = new OmpAgent({
			command: resolveOmpCommand(config.get<string>("path", "omp")),
			args,
			cwd: folder.uri.fsPath,
			handlers: {
				readTextFile: params => this.#readTextFile(params),
				writeTextFile: params => this.#writeTextFile(params),
				requestPermission: params => this.#requestPermission(params),
				elicit: params => this.#elicit(params),
				onSessionUpdate: update => this.#onSessionUpdate(update),
				onExit: message => this.#onAgentExit(agent, message),
				log: line => this.output.appendLine(line),
			},
		});
		this.#agent = agent;
		try {
			const session = await agent.start();
			this.output.appendLine(`omp session ${session.sessionId} started in ${folder.uri.fsPath}`);
			this.chat.post({ type: "config", options: agent.configOptions });
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
		this.reviews.cancelAll(reason);
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
			case "newSession":
				void this.newSession();
				break;
			case "respond": {
				const pending = this.#pending.get(message.requestId);
				if (!pending) return;
				this.#pending.delete(message.requestId);
				pending.resolve(message.value);
				break;
			}
			case "openReview":
				void this.reviews.open(message.reviewId);
				break;
			case "openFile":
				if (typeof message.path === "string") void vscode.window.showTextDocument(vscode.Uri.file(message.path));
				break;
			case "setConfig":
				void this.#setConfig(message.configId, message.value);
				break;
		}
	}

	/** Show a card in the chat and wait for the user's answer. */
	#ask<T>(card: Record<string, unknown>, cancelValue: T): Promise<T> {
		const requestId = String(nextRequestId++);
		this.chat.reveal();
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

		const outcome = await this.reviews.review(uri, displayPath, original, params.content);
		if ((await this.#currentText(uri)) !== current) {
			this.#notice("warning", `${displayPath} changed during the review, so omp's change was not saved.`);
			throw new RpcError(-32000, staleFileMessage(displayPath));
		}
		if (outcome.accepted.some(Boolean)) {
			await saveText(uri, applyDecisions(outcome.diff, outcome.accepted), current !== undefined);
		}
		if (outcome.accepted.every(Boolean)) return;
		throw new RpcError(-32000, rejectionMessage(displayPath, outcome.diff.hunks, outcome.accepted));
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
		const warn = vscode.workspace.getConfiguration("omp").get<boolean>("warnOnShellFileChanges", true);
		const optionId = await this.#ask<string | undefined>(
			{
				type: "permission",
				title: params.toolCall.title ?? "omp wants to run a tool",
				kind: params.toolCall.kind,
				command,
				warning: command && warn ? fileChangeWarning(command) : undefined,
				locations: params.toolCall.locations?.map(l => l.path),
				options: params.options,
			},
			undefined,
		);
		return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
	}

	async #elicit(params: ElicitationParams): Promise<ElicitationResult> {
		if (params.mode === "url") {
			// Not advertised in clientCapabilities; opening an agent-chosen URL unasked is unsafe.
			this.output.appendLine(`declined a request to open ${params.url}`);
			return { action: "decline" };
		}
		const properties = params.requestedSchema?.properties ?? {};
		const approval = parseApprovalMessage(params.message);
		const isApproveDeny = properties.value?.enum?.includes("Approve") && properties.value.enum.includes("Deny");

		if (approval && isApproveDeny) {
			const config = vscode.workspace.getConfiguration("omp");
			if (DIFF_REVIEWED_TOOLS.has(approval.toolName) && config.get<boolean>("autoApproveEditPrompts", true)) {
				this.output.appendLine(`auto-approved ${approval.toolName} (the diff review comes next): ${approval.details}`);
				return { action: "accept", content: { value: "Approve" } };
			}
			const warn = config.get<boolean>("warnOnShellFileChanges", true) && approval.toolName === "bash";
			const choice = await this.#ask<string | undefined>(
				{
					type: "approval",
					toolName: approval.toolName,
					details: approval.details,
					warning: warn ? fileChangeWarning(approval.details) : undefined,
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
