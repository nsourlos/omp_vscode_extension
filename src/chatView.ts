/**
 * The chat UI lives in an editor tab (like a file). The OMP icon in the activity bar
 * is a launcher: clicking it opens (or focuses) that tab and hands the sidebar back
 * to the Explorer. Messages are replayed whenever the tab is (re)created.
 */
import * as vscode from "vscode";
import { mergeChunk } from "./chatHistory";

export class ChatView implements vscode.WebviewViewProvider {
	static readonly viewId = "omp.chat";

	#panel: vscode.WebviewPanel | undefined;
	#ready = new Set<vscode.Webview>();
	#history: unknown[] = [];
	#messages = new vscode.EventEmitter<any>();
	readonly onMessage = this.#messages.event;

	constructor(private readonly extensionUri: vscode.Uri) {}

	/** The sidebar view: a launcher that opens the chat tab whenever it is shown. */
	resolveWebviewView(view: vscode.WebviewView): void {
		view.webview.options = { enableScripts: true };
		view.webview.html = launcherHtml(view.webview);
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

	/** Open the chat tab beside the current editor, or bring it to the front. */
	open(preserveFocus = false): void {
		if (this.#panel) {
			this.#panel.reveal(undefined, preserveFocus);
			return;
		}
		const media = vscode.Uri.joinPath(this.extensionUri, "media");
		const panel = vscode.window.createWebviewPanel(
			"omp.chatPanel",
			"OMP",
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus },
			{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
		);
		panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "omp.svg");
		panel.webview.html = chatHtml(panel.webview, media);
		panel.webview.onDidReceiveMessage(message => {
			if (message?.type === "ready") {
				this.#ready.add(panel.webview);
				for (const item of this.#history) void panel.webview.postMessage(item);
				return;
			}
			this.#messages.fire(message);
		});
		panel.onDidDispose(() => {
			this.#ready.delete(panel.webview);
			if (this.#panel === panel) this.#panel = undefined;
		});
		this.#panel = panel;
	}

	/** Move the chat tab into its own window. */
	async openInWindow(): Promise<void> {
		this.open();
		await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
	}

	post(message: unknown): void {
		const merged = mergeChunk(this.#history.at(-1), message);
		if (merged) this.#history[this.#history.length - 1] = merged;
		else this.#history.push(message);
		for (const webview of this.#ready) void webview.postMessage(message);
	}

	reset(): void {
		this.#history = [];
		this.post({ type: "reset" });
	}

	/** Make the chat visible without stealing focus from the editor. */
	reveal(): void {
		this.open(true);
	}
}

function nonce(): string {
	return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function launcherHtml(webview: vscode.Webview): string {
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

function chatHtml(webview: vscode.Webview, media: vscode.Uri): string {
	const n = nonce();
	const script = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js"));
	const style = webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.css"));
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>OMP</title>
</head>
<body>
<div id="log" role="log" aria-live="polite"></div>
<footer>
  <div id="settings"></div>
  <textarea id="input" rows="3" placeholder="Ask omp… (Enter to send, Shift+Enter for a new line)"></textarea>
  <div class="row">
    <span id="status">Not started</span>
    <span id="usage"></span>
    <button id="stop" class="secondary" hidden>Stop</button>
    <button id="send">Send</button>
  </div>
</footer>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
}
