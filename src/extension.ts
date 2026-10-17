import * as vscode from "vscode";
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
	const sessions = new Sessions(context.extensionUri, reviews, output);

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
		registerMcpCommands(),
	);
	return { sessions, reviews };
}

export function deactivate(): void {}
