/**
 * The open chat sessions: one editor tab and one omp process each, running independently.
 * The OMP icon in the activity bar is a launcher: it opens (or focuses) the last-used session's
 * tab and hands the sidebar back to the Explorer.
 */
import * as vscode from "vscode";
import { ChatPanel, nonce } from "./chatPanel";
import type { SavedSession } from "./acp/types";
import { Controller, listSavedChats } from "./controller";
import type { ReviewManager } from "./review/reviewManager";

export interface Session {
	panel: ChatPanel;
	controller: Controller;
}

export class Sessions implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = "omp.chat";

	#sessions: Session[] = [];
	#active: Session | undefined;
	#nextNumber = 1;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly reviews: ReviewManager,
		private readonly output: vscode.OutputChannel,
	) {}

	get all(): readonly Session[] {
		return this.#sessions;
	}

	/** The session used last. */
	get active(): Session | undefined {
		return this.#active;
	}

	/** The sidebar view: a launcher that opens the chat tab whenever it is shown. */
	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		view.webview.html = launcherHtml();
		view.webview.onDidReceiveMessage(message => {
			if (message?.type === "open") void this.openFromSidebar();
		});
		view.onDidChangeVisibility(() => {
			if (view.visible) void this.openFromSidebar();
		});
		if (view.visible) void this.openFromSidebar();
	}

	/** Open the chat tab, then show the Explorer again so files stay visible. */
	async openFromSidebar(): Promise<void> {
		this.open();
		await vscode.commands.executeCommand("workbench.view.explorer");
	}

	/** Bring the last-used session's tab to the front, or open a first session. */
	open(): Session {
		const session = this.#active ?? this.create();
		session.panel.reveal();
		return session;
	}

	/** Pick one of omp's saved chats for this folder and continue it in a tab. */
	async openSavedFromPicker(): Promise<void> {
		const saved = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: "OMP: reading saved chats" },
			() => listSavedChats(line => this.output.appendLine(`[history] ${line}`)),
		);
		const chats = saved.filter(chat => chat._meta?.messageCount !== 0); // nothing to continue in an empty chat
		if (chats.length === 0) {
			void vscode.window.showInformationMessage("omp has no saved chats for this folder yet.");
			return;
		}
		const picked = await vscode.window.showQuickPick(
			chats.map(chat => ({
				label: chat.title || "(untitled chat)",
				description: chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : undefined,
				detail: chat._meta?.messageCount !== undefined ? `${chat._meta.messageCount} messages` : undefined,
				chat,
			})),
			{ placeHolder: "Continue a previous omp chat", matchOnDescription: true },
		);
		if (picked) this.openSaved(picked.chat);
	}

	/** Continue a saved chat: bring its tab forward if it is open, else load it into a new tab. */
	openSaved(chat: SavedSession): Session {
		const open = this.#sessions.find(session => session.controller.sessionId === chat.sessionId);
		if (open) {
			open.panel.reveal();
			return open;
		}
		const session = this.create(chat);
		session.panel.reveal();
		void session.controller.start();
		return session;
	}

	/** Open a new session in its own tab, next to the current chat tab if there is one. */
	create(saved?: SavedSession): Session {
		const label = `OMP ${this.#nextNumber++}`;
		const panel: ChatPanel = new ChatPanel(
			this.extensionUri,
			label,
			this.#active?.panel.viewColumn ?? vscode.ViewColumn.Beside,
			(): boolean =>
				this.#sessions.some(other => other.panel !== panel && other.panel.visible && other.panel.viewColumn === panel.viewColumn),
		);
		const title = saved?.title?.trim();
		if (title) panel.setChatTitle(title);
		const controller = new Controller(
			panel,
			this.reviews,
			line => this.output.appendLine(`[${label}] ${line}`),
			saved?.sessionId,
			saved !== undefined && !title,
		);
		const session: Session = { panel, controller };
		this.#sessions.push(session);
		this.#active = session;
		panel.onDidBecomeActive(() => (this.#active = session));
		panel.onDidDispose(() => {
			controller.dispose();
			this.#sessions = this.#sessions.filter(other => other !== session);
			if (this.#active === session) this.#active = this.#sessions.at(-1);
		});
		return session;
	}

	/** Move the last-used session's tab into its own window. */
	async openInWindow(): Promise<void> {
		this.open();
		await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
	}

	dispose(): void {
		for (const session of [...this.#sessions]) session.panel.dispose();
	}
}


function launcherHtml(): string {
	const n = nonce();
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${n}';">
<style>
	body { padding: 12px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
	button { width: 100%; padding: 6px; border: none; cursor: pointer;
		color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
	button:hover { background: var(--vscode-button-hoverBackground); }
	p { opacity: 0.8; }
</style>
</head>
<body>
<p>The OMP chat opens as a tab next to your files.</p>
<button id="open">Open OMP chat</button>
<script nonce="${n}">
	const vscode = acquireVsCodeApi();
	document.getElementById("open").addEventListener("click", () => vscode.postMessage({ type: "open" }));
</script>
</body>
</html>`;
}
