/**
 * The open chat sessions: one editor tab and one omp process each, running independently.
 * The OMP icon in the activity bar is a launcher: it opens (or focuses) the last-used session's
 * tab and hands the sidebar back to the Explorer.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import * as vscode from "vscode";
import { ChatPanel, nonce } from "./chatPanel";
import type { SavedSession } from "./acp/types";
import { Controller, withListingOmp } from "./controller";
import type { ReviewManager } from "./review/reviewManager";
import { chatsToShow, continuedIn, forgetDeleted, otherFolderChats, type ContinuedChats } from "./savedChats";

/** The globalState key for the chats continued in another folder than they were saved under. */
const CONTINUED_CHATS = "omp.continuedChats";

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
		/** Where chats save copies of attached files that have no location of their own. */
		private readonly copiesRoot: string,
		/** The extension's state for every folder: which saved chats were continued in which folder. */
		private readonly globalState: vscode.Memento,
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
		if (this.#active) {
			this.#active.panel.reveal();
			return this.#active;
		}
		const session = this.create();
		session.panel.reveal();
		void session.controller.start(); // so the slash commands are there before the first message
		return session;
	}

	/**
	 * Pick one of omp's saved chats and continue it in a tab. The list holds this folder's chats (and
	 * ones continued here from another folder); every other folder's are read only when asked for,
	 * since that reads every chat omp has saved.
	 */
	async openSavedFromPicker(): Promise<void> {
		const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!folder) throw new Error("Open a folder first: omp works inside a project folder.");
		const log = (line: string): void => this.output.appendLine(`[history] ${line}`);
		const elsewhere = continuedIn(this.globalState.get<ContinuedChats>(CONTINUED_CHATS, {}), folder);
		const { mine, every } = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Window, title: "OMP: reading saved chats" },
			() =>
				withListingOmp(log, folder, async omp => ({
					mine: await omp.listSessions(),
					// Chats continued here are found among every folder's, by id: omp doesn't always find a
					// folder's chats by its path once the folder is gone (one under a symlink, like /tmp).
					// If that listing fails, they are left out, not the whole list.
					every: elsewhere.size
						? await omp.listSessions(null).catch(error => void log(`could not list every folder's chats: ${error instanceof Error ? error.message : error}`))
						: undefined,
				})),
		);
		if (every) await this.#updateContinued(continued => forgetDeleted(continued, every));
		const here = chatsToShow([...mine, ...(every ?? []).filter(chat => elsewhere.has(chat.sessionId))]);
		const shown = new Set(here.map(chat => chat.sessionId));
		const picked = await pickSavedChat(folder, here, async () => {
			const all = await withListingOmp(log, folder, omp => omp.listSessions(null));
			// Asynchronously, so a folder on a drive that no longer answers doesn't stall the editor.
			const folders = [...new Set(all.map(chat => chat.cwd))];
			const found = await Promise.all(folders.map(cwd => stat(cwd).then(() => true, () => false)));
			const existing = new Set(folders.filter((_, i) => found[i]));
			return otherFolderChats(all, shown, cwd => existing.has(cwd));
		});
		if (!picked) return;
		if (picked.cwd !== folder && !mine.some(chat => chat.sessionId === picked.sessionId)) {
			await this.#updateContinued(continued => ({ ...continued, [picked.sessionId]: { folder } }));
		}
		this.openSaved(picked);
	}

	/** Changes the record of continued chats, read afresh (another window may have changed it meanwhile). */
	async #updateContinued(change: (continued: ContinuedChats) => ContinuedChats): Promise<void> {
		const before = this.globalState.get<ContinuedChats>(CONTINUED_CHATS, {});
		const after = change(before);
		if (JSON.stringify(after) !== JSON.stringify(before)) await this.globalState.update(CONTINUED_CHATS, after);
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
			this.copiesRoot,
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

type ChatItem = vscode.QuickPickItem & { chat?: SavedSession; others?: true };

/**
 * The saved-chat list: `here` first, then, after the title-bar button or the last entry is picked,
 * the chats of every other folder, those whose folder is gone (renamed, moved or deleted) first.
 */
function pickSavedChat(
	folder: string,
	here: SavedSession[],
	loadOthers: () => Promise<{ moved: SavedSession[]; other: SavedSession[] }>,
): Promise<SavedSession | undefined> {
	const pick = vscode.window.createQuickPick<ChatItem>();
	const button: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon("folder-library"), tooltip: "Show chats from other folders" };
	const othersItem: ChatItem = { label: "$(folder-library) Show chats from other folders…", alwaysShow: true, others: true };
	const hereItems = here.map(chat => chatItem(chat, folder));
	const showHere = (): void => {
		pick.items = [...hereItems, othersItem];
		pick.buttons = [button];
		pick.placeholder = here.length ? "Continue a previous omp chat" : "omp has no saved chats for this folder yet";
	};
	pick.title = "Continue a previous omp chat";
	pick.matchOnDescription = true;
	pick.matchOnDetail = true;
	showHere();

	let loading = false;
	const showOthers = async (): Promise<void> => {
		if (loading) return;
		loading = true;
		pick.items = hereItems;
		pick.buttons = [];
		pick.busy = true;
		pick.placeholder = "Reading the chats of every folder…";
		try {
			const { moved, other } = await loadOthers();
			const group = (label: string, items: ChatItem[]): ChatItem[] =>
				items.length ? [{ label, kind: vscode.QuickPickItemKind.Separator }, ...items] : [];
			const items = (chats: SavedSession[]): ChatItem[] => chats.map(chat => chatItem(chat, folder));
			pick.items = [
				...group("This folder", hereItems),
				...group("Moved or deleted folders", items(moved)),
				...group("Other folders", items(other)),
			];
			pick.placeholder =
				moved.length || other.length ? "A chat from another folder continues in this one" : "omp has no chats from other folders";
		} catch (error) {
			loading = false;
			showHere();
			void vscode.window.showErrorMessage(`OMP: ${error instanceof Error ? error.message : error}`);
		} finally {
			pick.busy = false;
		}
	};

	return new Promise(resolve => {
		pick.onDidTriggerButton(() => void showOthers());
		pick.onDidAccept(() => {
			const [item] = pick.selectedItems;
			if (item?.others) return void showOthers();
			if (!item?.chat) return;
			resolve(item.chat);
			pick.hide();
		});
		pick.onDidHide(() => {
			resolve(undefined);
			pick.dispose();
		});
		pick.show();
	});
}

function chatItem(chat: SavedSession, folder: string): ChatItem {
	const home = homedir();
	const where = chat.cwd === folder ? undefined : chat.cwd.startsWith(home + sep) ? `~${chat.cwd.slice(home.length)}` : chat.cwd;
	const count = chat._meta?.messageCount !== undefined ? `${chat._meta.messageCount} messages` : undefined;
	const title = chat.title || "(untitled chat)";
	return {
		// A chat from another folder starts with that folder's name; its full path is in the detail line.
		label: where ? `${basename(chat.cwd) || chat.cwd}: ${title}` : title,
		description: chat.updatedAt ? new Date(chat.updatedAt).toLocaleString() : undefined,
		detail: [where, count].filter(Boolean).join(" · ") || undefined,
		chat,
	};
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
