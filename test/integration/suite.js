// Runs inside a real VS Code with the extension loaded, against a real `omp acp`.
// Clicks Accept on the first change of each review and Reject on the rest, like a user would.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log("[integration]", ...args);
const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);

exports.run = async function run() {
	const extension = vscode.extensions.getExtension("local.omp-vscode");
	assert.ok(extension, "extension is installed in the test VS Code");
	const api = await extension.activate();
	const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "demo.py");

	await vscode.commands.executeCommand("omp.openChat");
	await sleep(1000);
	assert.ok(
		allTabs().some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === "OMP"),
		"clicking OMP opens the chat as an editor tab",
	);
	log("chat tab opened");

	const reviews = [];
	api.reviews.onDidChangeReview(async info => {
		reviews.push(info);
		if (info.state !== "open") return;
		await sleep(1500); // give the diff editor time to open
		const diffOpen = allTabs().some(
			tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === "omp-review",
		);
		log(`review of ${info.displayPath}: ${info.hunkCount} change(s), diff editor open: ${diffOpen}`);
		info.diffOpen = diffOpen;
		await vscode.commands.executeCommand("omp.review.acceptHunk", info.id, 0);
		for (let i = 1; i < info.hunkCount; i++) await vscode.commands.executeCommand("omp.review.rejectHunk", info.id, i);
	});

	await api.controller.send(
		"In demo.py make exactly two changes in ONE edit call: change greet to print Hello instead of Hi, " +
			"and add a one-line docstring to add(). Then stop.",
	);

	const text = fs.readFileSync(file, "utf8");
	log(`demo.py after the turn:\n${text}`);
	const opened = reviews.filter(info => info.state === "open");
	const done = reviews.filter(info => info.state === "done");
	log(`reviews: ${done.map(info => `${info.displayPath} ${info.summary}`).join("; ")}`);
	assert.ok(opened.length > 0, "the edit went through the diff review");
	assert.ok(opened.every(info => info.diffOpen), "every review opened in the diff editor");
	assert.equal(done.length, opened.length, "every review finished");
	assert.match(text, /print\("Hello"\)/, "the accepted change was saved");
	assert.ok(!allTabs().some(tab => tab.input instanceof vscode.TabInputTextDiff), "diff tabs closed after review");
	log("PASS");
};
