// Runs inside a real VS Code with the extension loaded, against test/fixtures/fake-omp.mjs.
// No model calls: each prompt is a JSON list of steps the fake agent carries out.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
const reviewTabs = () =>
	allTabs().filter(tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === "omp-review");

async function waitFor(check, what, timeout = 10_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await sleep(50);
	}
	throw new Error(`timed out waiting for ${what}`);
}

function fakeLog() {
	const file = process.env.OMP_FAKE_LOG;
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

const steps = (...list) => JSON.stringify(list);

exports.run = async function run() {
	const extension = vscode.extensions.getExtension("local.omp-vscode");
	const api = await extension.activate();
	const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const file = name => path.join(root, name);

	const reviews = [];
	api.reviews.onDidChangeReview(info => reviews.push(info));
	const nextOpenReview = after =>
		waitFor(() => reviews.slice(after).find(info => info.state === "open"), "a review to open");

	const tests = {
		async "an accepted write is saved"() {
			fs.writeFileSync(file("a.txt"), "one\n");
			const seen = reviews.length;
			const turn = api.controller.send(steps({ write: { path: file("a.txt"), content: "one\ntwo\n" } }));
			const review = await nextOpenReview(seen);
			await vscode.commands.executeCommand("omp.review.acceptHunk", review.id, 0);
			await turn;
			assert.equal(fs.readFileSync(file("a.txt"), "utf8"), "one\ntwo\n");
			assert.equal(fakeLog().at(-1).error, undefined);
			await waitFor(() => reviewTabs().length === 0, "the diff tab to close");
		},

		async "a file changed during its review is not overwritten"() {
			fs.writeFileSync(file("b.txt"), "x\n");
			const seen = reviews.length;
			const turn = api.controller.send(steps({ write: { path: file("b.txt"), content: "x\ny\n" } }));
			const review = await nextOpenReview(seen);
			const document = await vscode.workspace.openTextDocument(file("b.txt"));
			const edit = new vscode.WorkspaceEdit();
			edit.insert(document.uri, new vscode.Position(0, 0), "typed by the user\n");
			await vscode.workspace.applyEdit(edit);
			await vscode.commands.executeCommand("omp.review.acceptHunk", review.id, 0);
			await turn;
			assert.equal(document.getText(), "typed by the user\nx\n");
			assert.match(fakeLog().at(-1).error ?? "", /changed while/);
		},
	};

	for (const [name, test] of Object.entries(tests)) {
		await test();
		console.log(`[offline] ok: ${name}`);
	}
};
