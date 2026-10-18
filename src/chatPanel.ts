/** One chat session's tab. Its messages are replayed whenever the webview (re)loads, e.g. after a window move. */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { mergeChunk } from "./chatHistory";

export const CHAT_PANEL_TYPE = "omp.chatPanel";

export class ChatPanel implements vscode.Disposable {
	#panel: vscode.WebviewPanel;
	#icon: vscode.Uri;
	#markedIcon: vscode.Uri;
	#ready = false;
	#disposed = false;
	#marked = false;
	#chatTitle: string | undefined;
	#history: unknown[] = [];
	#readyWaiters: (() => void)[] = [];
	#messages = new vscode.EventEmitter<any>();
	#activated = new vscode.EventEmitter<void>();
	readonly onMessage = this.#messages.event;
	/** Fires when this tab becomes the active editor. */
	readonly onDidBecomeActive = this.#activated.event;
	readonly onDidDispose: vscode.Event<void>;

	constructor(
		extensionUri: vscode.Uri,
		readonly label: string,
		viewColumn: vscode.ViewColumn,
		/** Whether revealing this tab would hide another session the user is looking at. */
		private readonly coversAnotherSession: () => boolean,
	) {
		const media = vscode.Uri.joinPath(extensionUri, "media");
		const dist = vscode.Uri.joinPath(extensionUri, "dist");
		const markdown = vscode.Uri.joinPath(dist, "markdown.js");
		this.#panel = vscode.window.createWebviewPanel(CHAT_PANEL_TYPE, label, viewColumn, {
			enableScripts: true,
			retainContextWhenHidden: true,
			// Folders only: VS Code serves files under these, and a single file listed here is not served.
			localResourceRoots: [media, dist],
		});
		this.#icon = vscode.Uri.joinPath(media, "omp.svg");
		this.#markedIcon = vscode.Uri.joinPath(media, "omp-done.svg");
		this.#panel.iconPath = this.#icon;
		this.#panel.webview.html = chatHtml(this.#panel.webview, media, markdown);
		this.#panel.webview.onDidReceiveMessage(message => this.receive(message));
		this.#panel.onDidChangeViewState(() => {
			if (this.#panel.visible) {
				this.#marked = false;
				this.#panel.title = this.#tabTitle();
				this.#panel.iconPath = this.#icon;
			}
			if (this.#panel.active) this.#activated.fire();
		});
		const settings = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration("omp.soundOnFinish")) this.#postSound();
		});
		// Registered before any outside listener, so cleanup that posts during dispose is dropped.
		this.#panel.onDidDispose(() => {
			this.#ready = false;
			this.#disposed = true;
			settings.dispose();
		});
		this.onDidDispose = this.#panel.onDidDispose;
	}

	get visible(): boolean {
		return this.#panel.visible;
	}

	get viewColumn(): vscode.ViewColumn | undefined {
		return this.#panel.viewColumn;
	}

	/** Handle a message from the chat page. Public so integration tests can stand in for the page. */
	receive(message: any): void {
		if (message?.type === "ready") {
			this.#ready = true;
			this.#postSound();
			for (const item of this.#history) void this.#panel.webview.postMessage(item);
			for (const resolve of this.#readyWaiters.splice(0)) resolve(); // run after the "ready" listeners below
		}
		this.#messages.fire(message);
	}

	/** Resolves once the page has loaded and can be posted to. */
	whenReady(): Promise<void> {
		return this.#ready ? Promise.resolve() : new Promise(resolve => this.#readyWaiters.push(resolve));
	}

	/** Tell the page whether to load the finish sound: on every (re)load, and when the setting changes. */
	#postSound(): void {
		this.notify({ type: "sound", on: vscode.workspace.getConfiguration("omp").get<boolean>("soundOnFinish", true) });
	}

	post(message: unknown): void {
		const merged = mergeChunk(this.#history.at(-1), message);
		if (merged) this.#history[this.#history.length - 1] = merged;
		else this.#history.push(message);
		if (this.#ready) void this.#panel.webview.postMessage(message);
	}

	/** Post a one-off message (like a sound) that a reloaded page must not replay. */
	notify(message: unknown): void {
		if (this.#ready) void this.#panel.webview.postMessage(message);
	}

	reveal(preserveFocus = false): void {
		this.#panel.reveal(undefined, preserveFocus);
	}

	/** The session needs an answer: mark the tab, and bring it forward unless that would hide another session. */
	requestAttention(): void {
		if (this.#panel.visible) return;
		this.#mark();
		if (!this.coversAnotherSession()) this.reveal(true);
	}

	/** A turn ended: if the tab is hidden, mark it until it is seen. */
	markFinished(): void {
		if (!this.#disposed && !this.#panel.visible) this.#mark();
	}

	#mark(): void {
		this.#marked = true;
		this.#panel.title = `● ${this.#tabTitle()}`;
		this.#panel.iconPath = this.#markedIcon;
	}

	/** The chat's name (from omp), shown on the tab after its label. */
	get chatTitle(): string | undefined {
		return this.#chatTitle;
	}

	/** Show the chat's name on the tab, or with undefined, only the tab's label. */
	setChatTitle(title: string | undefined): void {
		if (this.#disposed) return;
		this.#chatTitle = title;
		this.#panel.title = this.#marked ? `● ${this.#tabTitle()}` : this.#tabTitle();
	}

	#tabTitle(): string {
		if (!this.#chatTitle) return this.label;
		const name = this.#chatTitle.length > 32 ? `${this.#chatTitle.slice(0, 31)}…` : this.#chatTitle;
		return `${this.label}: ${name}`;
	}

	dispose(): void {
		this.#panel.dispose();
	}
}

/** A one-use value that lets only the page's own scripts run (its Content Security Policy). */
export function nonce(): string {
	return randomBytes(16).toString("hex");
}

function chatHtml(webview: vscode.Webview, media: vscode.Uri, markdown: vscode.Uri): string {
	const n = nonce();
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
	const markdownScript = webview.asWebviewUri(markdown);
	const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
	const chime = webview.asWebviewUri(vscode.Uri.joinPath(media, "staplebops-01.mp3"));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; media-src ${webview.cspSource}; img-src data:; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OMP</title>
</head>
<body data-chime="${chime}">
<div id="log" role="log" aria-live="polite"></div>
<div id="activity" hidden></div>
<div id="queue"></div>
<footer>
  <div id="settings"></div>
  <div id="attachments" hidden></div>
  <textarea id="input" rows="3" placeholder="Ask omp… (Enter to send, Shift+Enter for a new line)"></textarea>
  <div class="row">
    <button id="attach" class="secondary" title="Attach files. You can also hold Shift and drop files here, or paste an image." aria-label="Attach files">+</button>
    <span id="status">Not started</span>
    <span id="usage"></span>
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</footer>
<script nonce="${n}" src="${markdownScript}"></script>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
