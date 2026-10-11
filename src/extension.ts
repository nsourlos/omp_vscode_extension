import * as vscode from "vscode";
import { ChatView } from "./chatView";
import { Controller } from "./controller";
import { ReviewManager } from "./review/reviewManager";

/** Returned from activate() so integration tests can drive the extension. */
export interface OmpExtensionApi {
	controller: Controller;
	reviews: ReviewManager;
}

export function activate(context: vscode.ExtensionContext): OmpExtensionApi {
	const output = vscode.window.createOutputChannel("OMP");
	const reviews = new ReviewManager();
	const chat = new ChatView(context.extensionUri);
	const controller = new Controller(chat, reviews, output);

	context.subscriptions.push(
		output,
		reviews,
		controller,
		vscode.window.registerWebviewViewProvider(ChatView.viewId, chat),
		vscode.commands.registerCommand("omp.openChat", () => chat.open()),
		vscode.commands.registerCommand("omp.newSession", () => controller.newSession()),
		vscode.commands.registerCommand("omp.cancel", () => controller.cancel()),
		vscode.commands.registerCommand("omp.showLog", () => output.show()),
		vscode.commands.registerCommand("omp.openInWindow", () => chat.openInWindow()),
	);
	return { controller, reviews };
}

export function deactivate(): void {}
