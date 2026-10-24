import * as vscode from "vscode";
import { removeStaleCopies } from "./attachments";
import { registerMcpCommands } from "./mcpServers";
import { ReviewManager } from "./review/reviewManager";
import { Sessions } from "./sessions";

/** Returned from activate() so integration tests can drive the extension. */
export interface OmpExtensionApi {
	sessions: Sessions;
	reviews: ReviewManager;
}

export function activate(context: vscode.ExtensionContext): OmpExtensionApi {
	const output = vscode.window.createOutputChannel("OMP");
	const reviews = new ReviewManager();
	// In the extension's own storage, private to this user (a temp folder is shared by every user on Linux).
	const copiesRoot = vscode.Uri.joinPath(context.globalStorageUri, "attachments").fsPath;
	const sessions = new Sessions(context.extensionUri, reviews, output, copiesRoot, context.globalState);
	void removeStaleCopies(copiesRoot);

	context.subscriptions.push(
		output,
		reviews,
		sessions,
		vscode.window.registerWebviewViewProvider(Sessions.viewId, sessions),
		vscode.commands.registerCommand("omp.openChat", () => sessions.open()),
		vscode.commands.registerCommand("omp.newSession", () => {
			const session = sessions.create();
			session.panel.reveal();
			void session.controller.start();
		}),
		vscode.commands.registerCommand("omp.cancel", () => sessions.active?.controller.cancel()),
		vscode.commands.registerCommand("omp.openPreviousChat", () =>
			sessions.openSavedFromPicker().catch(error => void vscode.window.showErrorMessage(`OMP: ${error instanceof Error ? error.message : error}`)),
		),
		vscode.commands.registerCommand("omp.showLog", () => output.show()),
		vscode.commands.registerCommand("omp.openInWindow", () => sessions.openInWindow()),
		// From the Explorer's or an editor tab's menu (the file, or every selected file), else the open editor.
		vscode.commands.registerCommand("omp.attachToChat", (uri?: vscode.Uri, selected?: vscode.Uri[]) => {
			const files = selected?.length ? selected : uri instanceof vscode.Uri ? [uri] : [vscode.window.activeTextEditor?.document.uri].filter(Boolean);
			if (files.length === 0) return void vscode.window.showInformationMessage("OMP: open or select a file to attach.");
			sessions.open().controller.attachFiles(files as vscode.Uri[]);
		}),
		registerMcpCommands(),
	);
	return { sessions, reviews };
}

export function deactivate(): void {}
