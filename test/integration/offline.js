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
	const nextOpenReview = (after, owner) =>
		waitFor(
			() => reviews.slice(after).find(info => info.state === "open" && (!owner || info.owner === owner)),
			"a review to open",
		);
	const controller = api.sessions.open().controller;
	const newSession = async () => {
		await vscode.commands.executeCommand("omp.newSession");
		return api.sessions.active;
	};

	const tests = {
		async "an accepted write is saved"() {
			fs.writeFileSync(file("a.txt"), "one\n");
			const seen = reviews.length;
			const turn = controller.send(steps({ write: { path: file("a.txt"), content: "one\ntwo\n" } }));
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
			const turn = controller.send(steps({ write: { path: file("b.txt"), content: "x\ny\n" } }));
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

		async "a request to open a URL is declined"() {
			await controller.send(steps({ elicitUrl: "https://example.com" }));
			assert.deepEqual(fakeLog().at(-1).result, { action: "decline" });
		},

		async "Stop closes every queued review"() {
			const names = ["q1.txt", "q2.txt", "q3.txt"];
			for (const name of names) fs.writeFileSync(file(name), "a\n");
			const seen = reviews.length;
			const turn = controller.send(steps({ writes: names.map(name => ({ path: file(name), content: "b\n" })) }));
			await waitFor(() => reviews.slice(seen).filter(info => info.state !== "done").length === 3, "three queued reviews");
			await waitFor(() => reviewTabs().length === 1, "the first diff tab");
			controller.cancel();
			await turn;
			await sleep(1500); // let any tab that is (wrongly) still opening appear
			assert.equal(reviewTabs().length, 0);
		},

		async "a review that ends before its diff opens leaves no tab behind"() {
			fs.writeFileSync(file("f.txt"), "a\n");
			const stopOnOpen = api.reviews.onDidChangeReview(info => {
				if (info.state === "open" && info.displayPath === "f.txt") controller.cancel();
			});
			try {
				await controller.send(steps({ write: { path: file("f.txt"), content: "b\n" } }));
			} finally {
				stopOnOpen.dispose();
			}
			await sleep(1500); // let the diff finish opening
			assert.equal(reviewTabs().length, 0);
		},

		async "New Session opens another tab with its own omp"() {
			const before = fakeLog().length;
			const second = await newSession();
			assert.notEqual(second.controller, controller);
			assert.deepEqual(api.sessions.all.map(session => session.panel.label), ["OMP 1", "OMP 2"]);
			await waitFor(() => fakeLog().slice(before).some(entry => entry.event === "session/new"), "the second omp to start");
			const tabs = allTabs().filter(tab => tab.input instanceof vscode.TabInputWebview);
			assert.deepEqual(tabs.map(tab => tab.label).sort(), ["OMP 1", "OMP 2"]);
		},

		async "two sessions review and save in parallel"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("p1.txt"), "1\n");
			fs.writeFileSync(file("p2.txt"), "2\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("p1.txt"), content: "1\none\n" } }));
			const turnTwo = two.send(steps({ write: { path: file("p2.txt"), content: "2\ntwo\n" } }));
			const reviewOne = await nextOpenReview(seen, one.id);
			const reviewTwo = await nextOpenReview(seen, two.id);
			await waitFor(() => reviewTabs().length === 2, "both diff tabs, open at the same time");
			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewTwo.id, 0);
			await turnTwo;
			assert.equal(fs.readFileSync(file("p2.txt"), "utf8"), "2\ntwo\n");
			assert.equal(fs.readFileSync(file("p1.txt"), "utf8"), "1\n", "session 1's change is still waiting");
			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewOne.id, 0);
			await turnOne;
			assert.equal(fs.readFileSync(file("p1.txt"), "utf8"), "1\none\n");
			const writers = fakeLog().filter(entry => entry.event === "write" && entry.path.match(/p[12]\.txt$/));
			assert.equal(new Set(writers.map(entry => entry.sessionId)).size, 2, "each write came from its own omp");
		},

		async "Stop in one session leaves the other's review alone"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("s1.txt"), "a\n");
			fs.writeFileSync(file("s2.txt"), "a\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("s1.txt"), content: "b\n" } }));
			const turnTwo = two.send(steps({ write: { path: file("s2.txt"), content: "b\n" } }));
			await nextOpenReview(seen, one.id);
			const reviewTwo = await nextOpenReview(seen, two.id);
			await waitFor(() => reviewTabs().length === 2, "both diff tabs");
			one.cancel();
			await turnOne;
			await waitFor(() => reviewTabs().length === 1, "session 1's diff tab to close");
			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewTwo.id, 0);
			await turnTwo;
			assert.equal(fs.readFileSync(file("s1.txt"), "utf8"), "a\n");
			assert.equal(fs.readFileSync(file("s2.txt"), "utf8"), "b\n");
		},

		async "Accept All, Reject All and Submit never finish another session's review"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("w1.txt"), "a\n");
			fs.writeFileSync(file("w2.txt"), "a\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("w1.txt"), content: "b\n" } }));
			const turnTwo = two.send(steps({ write: { path: file("w2.txt"), content: "b\n" } }));
			const reviewOne = await nextOpenReview(seen, one.id);
			const reviewTwo = await nextOpenReview(seen, two.id);
			await waitFor(() => reviewTabs().length === 2, "both diff tabs");
			const finished = () => reviews.slice(seen).filter(info => info.state === "done").map(info => info.id);

			api.sessions.all[0].panel.reveal(); // a chat tab has focus, not a diff
			await waitFor(() => !vscode.window.activeTextEditor, "the chat tab to take focus");
			for (const command of ["omp.review.acceptAll", "omp.review.rejectAll", "omp.review.submit"]) {
				await vscode.commands.executeCommand(command);
			}
			await sleep(300);
			assert.deepEqual(finished(), [], "with two reviews open and none focused, nothing is decided");

			await api.reviews.open(reviewTwo.id);
			await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.startsWith(`/${reviewTwo.id}/`), "session 2's diff to take focus");
			await vscode.commands.executeCommand("omp.review.rejectAll");
			await turnTwo;
			assert.deepEqual(finished(), [reviewTwo.id], "only the focused review was decided");
			assert.equal(fs.readFileSync(file("w2.txt"), "utf8"), "a\n");

			api.sessions.all[0].panel.reveal();
			await waitFor(() => !vscode.window.activeTextEditor, "the chat tab to take focus");
			await vscode.commands.executeCommand("omp.review.submit");
			await turnOne;
			assert.deepEqual(finished(), [reviewTwo.id, reviewOne.id], "with one review left, Submit finishes it");
			assert.equal(fs.readFileSync(file("w1.txt"), "utf8"), "b\n");
		},

		async "closing a session's tab ends it and leaves the others running"() {
			const second = api.sessions.all[1];
			fs.writeFileSync(file("c.txt"), "a\n");
			const seen = reviews.length;
			void second.controller.send(steps({ write: { path: file("c.txt"), content: "b\n" } }));
			await nextOpenReview(seen, second.controller.id);
			second.panel.dispose();
			await waitFor(() => reviewTabs().length === 0, "the closed session's diff tab to close");
			assert.deepEqual(api.sessions.all.map(session => session.panel.label), ["OMP 1"]);
			assert.equal(fs.readFileSync(file("c.txt"), "utf8"), "a\n");
			await controller.send(steps({ elicitUrl: "https://example.com" }));
			assert.equal(fakeLog().at(-1).event, "elicitUrl", "session 1 still answers");
		},

		async "closing a tab while omp starts stops that omp"() {
			const config = vscode.workspace.getConfiguration("omp");
			const args = config.get("extraArgs");
			await config.update("extraArgs", [...args, "--init-delay", "1000"], vscode.ConfigurationTarget.Workspace);
			try {
				const before = fakeLog().length;
				const session = await newSession();
				await sleep(200);
				session.panel.dispose();
				await sleep(1500);
				assert.equal(fakeLog().slice(before).filter(entry => entry.event === "session/new").length, 0);
			} finally {
				await config.update("extraArgs", args, vscode.ConfigurationTarget.Workspace);
			}
		},
	};

	for (const [name, test] of Object.entries(tests)) {
		await test();
		console.log(`[offline] ok: ${name}`);
	}
};
