/**
 * Hunk-by-hunk review of a proposed file change in VS Code's diff editor.
 * Left side: the file as it is now. Right side: omp's proposal, with Accept/Reject
 * CodeLens buttons above every hunk. Reviews are queued and shown one at a time.
 */
import * as path from "node:path";
import * as vscode from "vscode";
import { diffFile, type FileDiff } from "./hunks";

export const REVIEW_SCHEME = "omp-review";

type Decision = "pending" | "accepted" | "rejected";

export interface ReviewOutcome {
	diff: FileDiff;
	accepted: boolean[];
}

export interface ReviewInfo {
	id: string;
	displayPath: string;
	hunkCount: number;
	state: "queued" | "open" | "done";
	summary?: string;
}

interface ReviewSession {
	id: string;
	fileUri: vscode.Uri;
	displayPath: string;
	original: string;
	proposed: string;
	diff: FileDiff;
	decisions: Decision[];
	originalUri: vscode.Uri;
	proposedUri: vscode.Uri;
	resolve: (outcome: ReviewOutcome) => void;
	reject: (error: Error) => void;
}

let nextReviewId = 1;

export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
	#queue: ReviewSession[] = [];
	#byId = new Map<string, ReviewSession>();
	#contentChanged = new vscode.EventEmitter<vscode.Uri>();
	#lensesChanged = new vscode.EventEmitter<void>();
	#reviewsChanged = new vscode.EventEmitter<ReviewInfo>();
	#statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	#disposables: vscode.Disposable[] = [];
	#acceptedDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		borderWidth: "0 0 0 3px",
		borderStyle: "solid",
		borderColor: new vscode.ThemeColor("charts.green"),
		overviewRulerColor: new vscode.ThemeColor("charts.green"),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});
	#rejectedDecoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		opacity: "0.45",
		textDecoration: "line-through",
		borderWidth: "0 0 0 3px",
		borderStyle: "solid",
		borderColor: new vscode.ThemeColor("charts.red"),
		overviewRulerColor: new vscode.ThemeColor("charts.red"),
		overviewRulerLane: vscode.OverviewRulerLane.Left,
	});

	readonly onDidChange = this.#contentChanged.event;
	readonly onDidChangeCodeLenses = this.#lensesChanged.event;
	/** Fires whenever a review is queued, opened or finished. */
	readonly onDidChangeReview = this.#reviewsChanged.event;

	constructor() {
		this.#statusBar.command = "omp.review.open";
		this.#disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this),
			vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
			vscode.window.onDidChangeVisibleTextEditors(() => this.#decorate()),
			vscode.commands.registerCommand("omp.review.acceptHunk", (id: string, index: number) =>
				this.#decide(id, index, "accepted"),
			),
			vscode.commands.registerCommand("omp.review.rejectHunk", (id: string, index: number) =>
				this.#decide(id, index, "rejected"),
			),
			vscode.commands.registerCommand("omp.review.acceptAll", () => this.#decideAll("accepted")),
			vscode.commands.registerCommand("omp.review.rejectAll", () => this.#decideAll("rejected")),
			vscode.commands.registerCommand("omp.review.submit", () => this.#submitActive()),
			vscode.commands.registerCommand("omp.review.open", (id?: string) => this.open(id)),
			vscode.commands.registerCommand("omp.review.acceptAtCursor", () => this.#decideAtCursor("accepted")),
			vscode.commands.registerCommand("omp.review.rejectAtCursor", () => this.#decideAtCursor("rejected")),
		);
	}

	/** Queue a review; resolves when the user has decided every hunk. */
	review(fileUri: vscode.Uri, displayPath: string, original: string, proposed: string): Promise<ReviewOutcome> {
		const id = String(nextReviewId++);
		const name = path.basename(fileUri.fsPath);
		const diff = diffFile(original, proposed);
		return new Promise<ReviewOutcome>((resolve, reject) => {
			const session: ReviewSession = {
				id,
				fileUri,
				displayPath,
				original,
				proposed,
				diff,
				decisions: diff.hunks.map(() => "pending"),
				originalUri: vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/original/${name}` }),
				proposedUri: vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/proposed/${name}` }),
				resolve,
				reject,
			};
			this.#queue.push(session);
			this.#byId.set(id, session);
			this.#emit(session, this.#queue.length === 1 ? "open" : "queued");
			this.#updateStatusBar();
			if (this.#queue.length === 1) void this.open(id);
		});
	}

	/** Show a review (default: the one at the front of the queue). */
	async open(id?: string): Promise<void> {
		const session = id ? this.#byId.get(id) : this.#queue[0];
		if (!session) {
			void vscode.window.showInformationMessage("No omp changes are waiting for review.");
			return;
		}
		const total = session.diff.hunks.length;
		const title = `${path.basename(session.fileUri.fsPath)} — omp proposes ${total} change${total === 1 ? "" : "s"}`;
		await vscode.commands.executeCommand("vscode.diff", session.originalUri, session.proposedUri, title, {
			preview: false,
		});
		this.#decorate();
	}

	/** Fail every queued review, e.g. when the turn is cancelled or omp exits. */
	cancelAll(reason: string): void {
		for (const session of [...this.#queue]) {
			this.#finish(session, `cancelled: ${reason}`);
			session.reject(new Error(reason));
		}
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const [, id, side] = uri.path.split("/");
		const session = this.#byId.get(id);
		if (!session) return "";
		return side === "original" ? session.original : session.proposed;
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const session = this.#sessionForUri(document.uri);
		if (!session || !document.uri.path.includes("/proposed/")) return [];
		const total = session.diff.hunks.length;
		const lenses: vscode.CodeLens[] = [];
		for (const hunk of session.diff.hunks) {
			const line = Math.min(hunk.newStart, Math.max(document.lineCount - 1, 0));
			const range = new vscode.Range(line, 0, line, 0);
			const label = `Change ${hunk.index + 1}/${total}${hunk.newLines.length === 0 ? " (deletion)" : ""}`;
			const decision = session.decisions[hunk.index];
			const accept = { title: "$(check) Accept", command: "omp.review.acceptHunk", arguments: [session.id, hunk.index] };
			const reject = { title: "$(close) Reject", command: "omp.review.rejectHunk", arguments: [session.id, hunk.index] };
			if (decision === "pending") {
				lenses.push(new vscode.CodeLens(range, { title: label, command: "" }));
				lenses.push(new vscode.CodeLens(range, accept), new vscode.CodeLens(range, reject));
			} else if (decision === "accepted") {
				lenses.push(new vscode.CodeLens(range, { ...reject, title: `$(pass-filled) ${label}: accepted — click to reject` }));
			} else {
				lenses.push(new vscode.CodeLens(range, { ...accept, title: `$(error) ${label}: rejected — click to accept` }));
			}
		}
		return lenses;
	}

	dispose(): void {
		this.cancelAll("extension shutting down");
		for (const disposable of this.#disposables) disposable.dispose();
		this.#statusBar.dispose();
		this.#acceptedDecoration.dispose();
		this.#rejectedDecoration.dispose();
	}

	#sessionForUri(uri: vscode.Uri): ReviewSession | undefined {
		if (uri.scheme !== REVIEW_SCHEME) return undefined;
		return this.#byId.get(uri.path.split("/")[1]);
	}

	/** The review in the focused editor, else the front of the queue. */
	#activeSession(): ReviewSession | undefined {
		const uri = vscode.window.activeTextEditor?.document.uri;
		const session = uri ? this.#sessionForUri(uri) : undefined;
		return session && this.#queue.includes(session) ? session : this.#queue[0];
	}

	#decide(id: string, index: number, decision: Decision): void {
		const session = this.#byId.get(id);
		if (!session || !this.#queue.includes(session)) return;
		session.decisions[index] = decision;
		this.#lensesChanged.fire();
		this.#decorate();
		if (session.decisions.every(d => d !== "pending")) void this.#complete(session);
	}

	/** Keyboard/context-menu fallback: decide the hunk under the cursor (either side of the diff). */
	#decideAtCursor(decision: Decision): void {
		const editor = vscode.window.activeTextEditor;
		const session = editor && this.#sessionForUri(editor.document.uri);
		if (!editor || !session) return;
		const line = editor.selection.active.line;
		const onProposed = editor.document.uri.path.includes("/proposed/");
		const contains = (start: number, count: number) => line >= start && line < start + Math.max(count, 1);
		const hunk = session.diff.hunks.find(h =>
			onProposed ? contains(h.newStart, h.newLines.length) : contains(h.oldStart, h.oldLines.length),
		);
		if (!hunk) {
			void vscode.window.showInformationMessage("Put the cursor on a changed line first.");
			return;
		}
		this.#decide(session.id, hunk.index, decision);
	}

	#decideAll(decision: Decision): void {
		const session = this.#activeSession();
		if (!session) return;
		session.decisions = session.decisions.map(() => decision);
		void this.#complete(session);
	}

	#submitActive(): void {
		const session = this.#activeSession();
		if (!session) return;
		session.decisions = session.decisions.map(d => (d === "pending" ? "accepted" : d));
		void this.#complete(session);
	}

	async #complete(session: ReviewSession): Promise<void> {
		if (!this.#queue.includes(session)) return;
		const accepted = session.decisions.map(d => d === "accepted");
		const acceptedCount = accepted.filter(Boolean).length;
		this.#finish(session, `${acceptedCount}/${accepted.length} accepted`);
		session.resolve({ diff: session.diff, accepted });
	}

	#finish(session: ReviewSession, summary: string): void {
		this.#queue = this.#queue.filter(s => s !== session);
		const tabs = vscode.window.tabGroups.all
			.flatMap(group => group.tabs)
			.filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === session.proposedUri.toString());
		if (tabs.length > 0) void vscode.window.tabGroups.close(tabs);
		this.#emit(session, "done", summary);
		this.#updateStatusBar();
		const next = this.#queue[0];
		if (next) {
			this.#emit(next, "open");
			void this.open(next.id);
		}
		// Keep the virtual documents resolvable briefly for tabs that are still closing.
		setTimeout(() => this.#byId.delete(session.id), 60_000);
	}

	#decorate(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const session = this.#sessionForUri(editor.document.uri);
			if (!session || !editor.document.uri.path.includes("/proposed/")) continue;
			const ranges = (wanted: Decision) =>
				session.diff.hunks
					.filter(h => session.decisions[h.index] === wanted && h.newLines.length > 0)
					.map(h => new vscode.Range(h.newStart, 0, h.newStart + h.newLines.length - 1, 0));
			editor.setDecorations(this.#acceptedDecoration, ranges("accepted"));
			editor.setDecorations(this.#rejectedDecoration, ranges("rejected"));
		}
	}

	#emit(session: ReviewSession, state: ReviewInfo["state"], summary?: string): void {
		this.#reviewsChanged.fire({
			id: session.id,
			displayPath: session.displayPath,
			hunkCount: session.diff.hunks.length,
			state,
			summary,
		});
	}

	#updateStatusBar(): void {
		const count = this.#queue.length;
		if (count === 0) {
			this.#statusBar.hide();
			return;
		}
		this.#statusBar.text = `$(diff) omp: ${count} file${count === 1 ? "" : "s"} to review`;
		this.#statusBar.tooltip = "Open the pending omp change review";
		this.#statusBar.show();
	}
}
