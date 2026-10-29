/**
 * The open chat sessions: one editor tab and one omp process each, running independently.
 * The OMP icon in the activity bar is a launcher: it opens (or focuses) the last-used session's
 * tab and hands the sidebar back to the Explorer.
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, sep } from "node:path";
import * as vscode from "vscode";
import { CHAT_PANEL_TYPE, ChatPanel, nonce } from "./chatPanel";
import type { SavedSession } from "./acp/types";
import { Controller, withListingOmp } from "./controller";
import type { ReviewManager } from "./review/reviewManager";
import { chatsToShow, continuedIn, forgetDeleted, otherFolderChats, type ContinuedChats } from "./savedChats";
import { newTabState, readTabState, unsentFiles, unsentText, type TabState } from "./tabState";

/** The globalState key for the chats continued in another folder than they were saved under. */
const CONTINUED_CHATS = "omp.continuedChats";
/**
 * The workspaceState key for which chat each open tab shows, by the tab's name. VS Code hands a tab
 * back (with its state) only when it is first shown, so this is how a tab behind another is known.
 */
const OPEN_TABS = "omp.openChatTabs";
/** VS Code's commands to focus the first to eighth editor group, counted by their place on screen (a group's column). */
const FOCUS_GROUP = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth"].map(n => `workbench.action.focus${n}EditorGroup`);

export interface Session {
	panel: ChatPanel;
	controller: Controller;
}

export class Sessions implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = "omp.chat";

	#sessions: Session[] = [];
	#active: Session | undefined;
	#nextNumber = 1;
	/** Waiting for VS Code to restore a tab brought forward, by the tab's name (see #showUnrestored). */
	#restoreWaiters = new Map<string, (session: Session) => void>();

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly reviews: ReviewManager,
		private readonly output: vscode.OutputChannel,
		/** Where chats save copies of attached files that have no location of their own. */
		private readonly copiesRoot: string,
		/** The extension's state for every folder: which saved chats were continued in which folder. */
		private readonly globalState: vscode.Memento,
		/** This folder's: which chat each open tab shows (OPEN_TABS). */
		private readonly workspaceState: vscode.Memento,
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
		await this.show();
		await vscode.commands.executeCommand("workbench.view.explorer");
	}

	/**
	 * Like open(), but when no chat tab has been restored yet and one is open behind another (VS Code
	 * restores a tab only when it is first shown), that one is brought forward instead of a new one opened.
	 */
	async show(): Promise<Session> {
		if (!this.#active) {
			// The one showing first: at startup VS Code may be about to restore it.
			const tab = chatTabs().find(open => open.isActive) ?? chatTabs()[0];
			const restored = tab && (await this.#showUnrestored(tab));
			if (restored) return restored;
		}
		return this.open();
	}

	/** Bring a tab VS Code hasn't restored yet to the front, which makes VS Code restore it; its session, or undefined if that didn't happen. */
	async #showUnrestored(tab: vscode.Tab): Promise<Session | undefined> {
		const label = labelOf(tab);
		const focusGroup = FOCUS_GROUP[tab.group.viewColumn - 1];
		if (!label || !focusGroup) return undefined;
		let resolveRestored: (session: Session | undefined) => void = () => {};
		const restored = new Promise<Session | undefined>(resolve => (resolveRestored = resolve));
		this.#restoreWaiters.set(label, resolveRestored);
		const timer = setTimeout(() => resolveRestored(undefined), 5000);
		try {
			await vscode.commands.executeCommand(focusGroup);
			// Only if the group focused holds the tab (one in another window doesn't count in the main window's
			// numbers): opening by position elsewhere would bring another editor forward.
			const index = vscode.window.tabGroups.activeTabGroup.tabs.findIndex(open => labelOf(open) === label);
			if (index < 0) return undefined;
			await vscode.commands.executeCommand("workbench.action.openEditorAtIndex", index);
			return await restored;
		} finally {
			clearTimeout(timer);
			if (this.#restoreWaiters.get(label) === resolveRestored) this.#restoreWaiters.delete(label);
		}
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
		// Open in a tab VS Code hasn't restored yet: that tab, not a second one on the same chat.
		const label = Object.entries(this.workspaceState.get<Record<string, string>>(OPEN_TABS, {})).find(([, id]) => id === picked.sessionId)?.[0];
		const tab = label && !this.#sessions.some(session => session.panel.label === label) ? chatTabs().find(open => labelOf(open) === label) : undefined;
		if (tab) {
			if (await this.#showUnrestored(tab)) return;
			void vscode.window.showInformationMessage(`OMP: this chat is already open in the tab "${label}": click that tab to continue it.`);
			return;
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

	/**
	 * A chat tab VS Code brought back after a restart, where it was: its chat is loaded again (one
	 * where nothing was sent starts afresh), and what wasn't sent goes back in the input.
	 */
	restore(webviewPanel: vscode.WebviewPanel, state: unknown): Session {
		const tab = readTabState(state) ?? newTabState(this.#newLabel());
		const saved = tab.saved && tab.sessionId ? { sessionId: tab.sessionId, cwd: "", title: tab.title } : undefined;
		const session = this.create(saved, { panel: webviewPanel, tab });
		if (!webviewPanel.active) this.#active = this.#sessions.find(other => other.panel.active) ?? session; // the tab in front stays the one used last
		const text = unsentText(tab);
		if (text) void session.panel.whenReady().then(() => session.panel.notify({ type: "restoreUnsent", text }));
		const files = unsentFiles(tab);
		const notes = files.length ? [`Files attached to what wasn't sent can't be kept when VS Code closes; attach them again: ${files.join(", ")}`] : [];
		void session.controller.start(notes);
		this.#restoreWaiters.get(session.panel.label)?.(session);
		return session;
	}

	/** A name for a new tab that no open tab has, restored or not. */
	#newLabel(): string {
		const taken = chatTabs().map(tab => Number(labelOf(tab)?.slice(4) ?? 0));
		const number = Math.max(this.#nextNumber, ...taken.map(n => n + 1));
		this.#nextNumber = number + 1;
		return `OMP ${number}`;
	}

	/** Note which chat the tab shows, for a restart (OPEN_TABS); tabs no longer open are dropped. */
	#recordTab(label: string, sessionId: string | undefined): void {
		const open = new Set(chatTabs().map(labelOf));
		const before = this.workspaceState.get<Record<string, string>>(OPEN_TABS, {});
		const after = Object.fromEntries(Object.entries(before).filter(([name]) => name !== label && open.has(name)));
		if (sessionId) after[label] = sessionId;
		if (JSON.stringify(after) !== JSON.stringify(before)) void this.workspaceState.update(OPEN_TABS, after);
	}

	/** Open a new session in its own tab, next to the current chat tab if there is one (or in the restored tab given). */
	create(saved?: SavedSession, restored?: { panel: vscode.WebviewPanel; tab: TabState }): Session {
		const label = restored?.tab.label ?? this.#newLabel();
		const panel: ChatPanel = new ChatPanel(
			this.extensionUri,
			label,
			this.#active?.panel.viewColumn ?? vscode.ViewColumn.Beside,
			(): boolean =>
				this.#sessions.some(other => other.panel !== panel && other.panel.visible && other.panel.viewColumn === panel.viewColumn),
			saved?.sessionId,
			restored?.panel,
		);
		const title = saved?.title?.trim();
		if (title) panel.setChatTitle(title);
		const controller = new Controller(
			panel,
			this.reviews,
			line => this.output.appendLine(`[${label}] ${line}`),
			this.copiesRoot,
			saved?.sessionId,
			// A restored tab isn't named on startup (every restart would ask again): only after its next reply.
			saved !== undefined && !title && !restored,
			saved !== undefined && restored?.tab.busy === true,
		);
		const session: Session = { panel, controller };
		this.#sessions.push(session);
		this.#active = session;
		panel.onDidBecomeActive(() => (this.#active = session));
		// Only when the chat it shows changes, and never after the tab is closed (a late update would list it again).
		let recorded = saved?.sessionId;
		let closed = false;
		panel.onDidChangeTabState(tab => {
			const sessionId = tab.saved ? tab.sessionId : undefined;
			if (closed || sessionId === recorded) return;
			recorded = sessionId;
			this.#recordTab(label, sessionId);
		});
		if (saved) this.#recordTab(label, saved.sessionId);
		panel.onDidDispose(() => {
			closed = true;
			this.#recordTab(label, undefined); // closed by the user (VS Code closing leaves the tabs, see dispose)
			controller.dispose();
			this.#sessions = this.#sessions.filter(other => other !== session);
			if (this.#active === session) this.#active = this.#sessions.at(-1);
		});
		return session;
	}

	/** Move the last-used session's tab into its own window. */
	async openInWindow(): Promise<void> {
		await this.show();
		await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
	}

	/** Stop every chat's omp. The tabs stay: when VS Code is closing, it brings them back next time (restore). */
	dispose(): void {
		for (const session of this.#sessions) session.controller.dispose();
	}
}

/** The OMP chat tabs VS Code has open, in every group, restored or not yet. */
function chatTabs(): vscode.Tab[] {
	return vscode.window.tabGroups.all
		.flatMap(group => group.tabs)
		.filter(tab => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(CHAT_PANEL_TYPE));
}

/** A chat tab's name ("OMP 2"), from its title ("● OMP 2: Fix the parser"). */
function labelOf(tab: vscode.Tab): string | undefined {
	return /^(?:● )?(OMP \d+)(?::|$)/.exec(tab.label)?.[1];
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
