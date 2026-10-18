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
	/** Every message the extension sends to this chat tab, from the first call on. */
	const postsOf = panel => {
		if (!panel.recorded) {
			const posts = [];
			const post = panel.post.bind(panel);
			panel.post = message => {
				posts.push(message);
				post(message);
			};
			panel.recorded = posts;
		}
		return panel.recorded;
	};
	/** Every one-off message (chimes, text put back in the input) sent to this chat tab, from the first call on. */
	const notificationsOf = panel => {
		if (!panel.notified) {
			const sent = [];
			const notify = panel.notify.bind(panel);
			panel.notify = message => {
				sent.push(message);
				notify(message);
			};
			panel.notified = sent;
		}
		return panel.notified;
	};
	const respond = (panel, card, value, label) => panel.receive({ type: "respond", requestId: card.requestId, value, label });
	const tabLabel = panel =>
		allTabs().find(tab => tab.input instanceof vscode.TabInputWebview && tab.label.endsWith(panel.label))?.label;

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

		async "with one diff open and another queued, Accept All from the chat finishes the open one"() {
			fs.writeFileSync(file("x1.txt"), "a\n");
			fs.writeFileSync(file("x2.txt"), "a\n");
			const seen = reviews.length;
			const turn = controller.send(steps({ writes: ["x1.txt", "x2.txt"].map(name => ({ path: file(name), content: "b\n" })) }));
			await waitFor(() => reviews.slice(seen).length === 2, "one open and one queued review");
			const [open, queued] = reviews.slice(seen);
			await waitFor(() => reviewTabs().length === 1, "the open review's diff");
			api.sessions.all[0].panel.reveal();
			await waitFor(() => !vscode.window.activeTextEditor, "the chat tab to take focus");
			await vscode.commands.executeCommand("omp.review.acceptAll");
			await waitFor(() => reviews.some(info => info.id === open.id && info.state === "done"), "the open review to finish");
			await waitFor(() => reviews.some(info => info.id === queued.id && info.state === "open"), "the queued review to open next");
			await vscode.commands.executeCommand("omp.review.acceptHunk", queued.id, 0);
			await turn;
			assert.equal(fs.readFileSync(file("x1.txt"), "utf8"), "b\n");
			assert.equal(fs.readFileSync(file("x2.txt"), "utf8"), "b\n");
		},

		async "a review that ends before its diff opens leaves no tab behind"() {
			fs.writeFileSync(file("f.txt"), "a\n");
			const stopOnOpen = api.reviews.onDidChangeReview(info => {
				if (info.state === "open" && info.displayPath === "f.txt") controller.cancel();
			});
			const opening = [];
			const open = api.reviews.open;
			api.reviews.open = (...args) => {
				const shown = open.apply(api.reviews, args);
				opening.push(shown);
				return shown;
			};
			try {
				await controller.send(steps({ write: { path: file("f.txt"), content: "b\n" } }));
			} finally {
				stopOnOpen.dispose();
				delete api.reviews.open;
			}
			assert.equal(opening.length, 1, "the review's diff was asked to open");
			await Promise.all(opening);
			await waitFor(() => reviewTabs().length === 0, "the diff that finished opening after its review ended to close");
		},

		async "a change or a whole file rejected with a note sends the note to omp in the same turn"() {
			fs.writeFileSync(file("n1.txt"), "1\n2\n3\n");
			let seen = reviews.length;
			let turn = controller.send(steps({ write: { path: file("n1.txt"), content: "one\n2\nthree\n" } }));
			const info = await nextOpenReview(seen);
			await vscode.commands.executeCommand("omp.review.acceptHunk", info.id, 0);
			await vscode.commands.executeCommand("omp.review.rejectHunkWithNote", info.id, 1, "write it as THREE");
			await turn;
			assert.equal(fs.readFileSync(file("n1.txt"), "utf8"), "one\n2\n3\n", "the rejected change was not saved");
			assert.match(fakeLog().at(-1).error, /\+three\nThe user's note on this change: write it as THREE/);
			assert.match(fakeLog().at(-1).error, /Do what the user's notes ask/);

			fs.writeFileSync(file("n2.txt"), "a\n");
			seen = reviews.length;
			turn = controller.send(steps({ write: { path: file("n2.txt"), content: "b\n" } }));
			const whole = await nextOpenReview(seen);
			const diff = vscode.Uri.from({ scheme: "omp-review", path: `/${whole.id}/proposed/n2.txt` });
			await vscode.commands.executeCommand("omp.review.rejectAllWithNote", diff, "split this into two files");
			await turn;
			assert.equal(fs.readFileSync(file("n2.txt"), "utf8"), "a\n");
			assert.match(fakeLog().at(-1).error, /The user's note on this file: split this into two files/);

			fs.writeFileSync(file("n3.txt"), "1\n2\n3\n");
			seen = reviews.length;
			turn = controller.send(steps({ write: { path: file("n3.txt"), content: "one\n2\nthree\n" } }));
			const changed = await nextOpenReview(seen);
			await vscode.commands.executeCommand("omp.review.rejectHunkWithNote", changed.id, 0, "withdrawn note");
			await vscode.commands.executeCommand("omp.review.acceptHunk", changed.id, 0); // changed their mind
			await vscode.commands.executeCommand("omp.review.rejectHunk", changed.id, 0); // then a plain reject
			await vscode.commands.executeCommand("omp.review.rejectHunk", changed.id, 1);
			await turn;
			assert.doesNotMatch(fakeLog().at(-1).error, /withdrawn note/, "a note the user took back is not sent");
			assert.match(fakeLog().at(-1).error, /gave no further explanation/);

			fs.writeFileSync(file("n4.txt"), "1\n2\n3\n");
			seen = reviews.length;
			turn = controller.send(steps({ write: { path: file("n4.txt"), content: "one\n2\nthree\n" } }));
			const again = await nextOpenReview(seen);
			await vscode.commands.executeCommand("omp.review.rejectHunkWithNote", again.id, 0, "use a Map instead");
			await vscode.commands.executeCommand("omp.review.rejectHunk", again.id, 0); // rejected again, e.g. with the keyboard
			await vscode.commands.executeCommand("omp.review.rejectHunk", again.id, 1);
			await turn;
			assert.match(fakeLog().at(-1).error, /The user's note on this change: use a Map instead/, "rejecting again keeps the note");
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

		async "accept one change and reject another while a second session edits another file"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("u1.txt"), "1\n2\n3\n");
			fs.writeFileSync(file("u2.txt"), "a\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("u1.txt"), content: "one\n2\nthree\n" } }));
			const turnTwo = two.send(steps({ write: { path: file("u2.txt"), content: "a\nb\n" } }));
			const reviewOne = await nextOpenReview(seen, one.id);
			const reviewTwo = await nextOpenReview(seen, two.id);
			assert.equal(reviewOne.hunkCount, 2);

			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewOne.id, 0);
			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewTwo.id, 0);
			await turnTwo;
			assert.equal(fs.readFileSync(file("u2.txt"), "utf8"), "a\nb\n");
			assert.equal(fs.readFileSync(file("u1.txt"), "utf8"), "1\n2\n3\n", "session 1 is still deciding");

			await vscode.commands.executeCommand("omp.review.rejectHunk", reviewOne.id, 1);
			await turnOne;
			assert.equal(fs.readFileSync(file("u1.txt"), "utf8"), "one\n2\n3\n");
			const writes = fakeLog().filter(entry => entry.event === "write");
			const toOne = writes.find(entry => entry.path === file("u1.txt"));
			const toTwo = writes.find(entry => entry.path === file("u2.txt"));
			assert.match(toOne.error, /accepted 1 of 2/);
			assert.match(toOne.error, /\+three/, "session 1's omp is told which change was rejected");
			assert.equal(toTwo.error, undefined, "session 2's omp is told its write succeeded");
			assert.notEqual(toOne.sessionId, toTwo.sessionId);
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

		async "Accept All, Reject All and Submit on a file with three changes"() {
			const original = "1\n2\n3\n4\n5\n";
			const proposed = "one\n2\nthree\n4\nfive\n";
			// A fresh file per round: rewriting one VS Code already has open races its reload and
			// can turn the next save into an "file is newer on disk" conflict that waits for a click.
			let round = 0;
			const review = async decide => {
				const name = `m${++round}.txt`;
				fs.writeFileSync(file(name), original);
				const seen = reviews.length;
				const turn = controller.send(steps({ write: { path: file(name), content: proposed } }));
				const info = await nextOpenReview(seen);
				await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.startsWith(`/${info.id}/`), "the diff to take focus");
				await decide(info);
				await turn;
				return { text: fs.readFileSync(file(name), "utf8"), error: fakeLog().at(-1).error };
			};

			const all = await review(() => vscode.commands.executeCommand("omp.review.acceptAll"));
			assert.deepEqual(all, { text: proposed, error: undefined });

			const none = await review(() => vscode.commands.executeCommand("omp.review.rejectAll"));
			assert.equal(none.text, original);
			assert.match(none.error, /rejected this change/);

			const submitted = await review(async info => {
				await vscode.commands.executeCommand("omp.review.rejectHunk", info.id, 1);
				await vscode.commands.executeCommand("omp.review.submit");
			});
			assert.equal(submitted.text, "one\n2\n3\n4\nfive\n", "Submit accepts the undecided changes, not the rejected one");
			assert.match(submitted.error, /accepted 2 of 3/);
		},

		async "Alt+Y and Alt+N accept or reject the change under the cursor"() {
			const bindings = extension.packageJSON.contributes.keybindings;
			assert.deepEqual(
				bindings.map(binding => [binding.key, binding.command]),
				[["alt+y", "omp.review.acceptAtCursor"], ["alt+n", "omp.review.rejectAtCursor"]],
			);
			assert.ok(bindings.every(binding => binding.when.includes("resourceScheme == omp-review")));

			fs.writeFileSync(file("k.txt"), "1\n2\n3\n");
			const seen = reviews.length;
			const turn = controller.send(steps({ write: { path: file("k.txt"), content: "one\n2\nthree\n" } }));
			const info = await nextOpenReview(seen);
			const editor = await waitFor(() => {
				const active = vscode.window.activeTextEditor;
				return active?.document.uri.path.startsWith(`/${info.id}/`) && active;
			}, "the diff to take focus");
			editor.selection = new vscode.Selection(2, 0, 2, 0);
			await vscode.commands.executeCommand("omp.review.rejectAtCursor");
			editor.selection = new vscode.Selection(0, 1, 0, 1);
			await vscode.commands.executeCommand("omp.review.acceptAtCursor");
			await turn;
			assert.equal(fs.readFileSync(file("k.txt"), "utf8"), "one\n2\n3\n");
		},

		async "cards in two sessions at once stay with their own session"() {
			const [first, second] = api.sessions.all;
			const postsOne = postsOf(first.panel);
			const postsTwo = postsOf(second.panel);
			const seenOne = postsOne.length;
			const seenTwo = postsTwo.length;
			const logged = fakeLog().length;
			const turnOne = first.controller.send(steps({ permission: "ls -la" }));
			const turnTwo = second.controller.send(steps({ approve: "bash\nrm -rf build" }));
			const cardOne = await waitFor(() => postsOne.slice(seenOne).find(m => m.type === "permission"), "session 1's card");
			const cardTwo = await waitFor(() => postsTwo.slice(seenTwo).find(m => m.type === "approval"), "session 2's card");
			assert.ok(!postsOne.slice(seenOne).some(m => m.type === "approval"), "session 2's card is not in session 1");
			assert.ok(!postsTwo.slice(seenTwo).some(m => m.type === "permission"), "session 1's card is not in session 2");
			assert.match(cardTwo.warning, /file command/);

			respond(first.panel, cardTwo, "Approve", "Approved");
			await sleep(300);
			assert.ok(!fakeLog().slice(logged).some(e => e.event === "approve"), "an answer from the wrong tab is ignored");

			respond(second.panel, cardTwo, "Deny", "Denied");
			await turnTwo;
			const approve = fakeLog().slice(logged).find(e => e.event === "approve");
			assert.deepEqual(approve.result, { action: "accept", content: { value: "Deny" } });
			assert.ok(postsTwo.some(m => m.type === "resolved" && m.requestId === cardTwo.requestId && m.label === "Denied"));
			assert.ok(!fakeLog().slice(logged).some(e => e.event === "permission"), "session 1 is still waiting");

			respond(first.panel, cardOne, "allow_once", "Allow once");
			await turnOne;
			const permission = fakeLog().slice(logged).find(e => e.event === "permission");
			assert.deepEqual(permission.result, { outcome: { outcome: "selected", optionId: "allow_once" } });
		},

		async "a browser approval shows the page only when one running code step can be the one asking"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const seen = posts.length;
			const evalCall = (id, page, status) => ({
				sessionUpdate: status ? "tool_call_update" : "tool_call",
				toolCallId: id,
				kind: "other",
				status: status ?? "in_progress",
				rawInput: { language: "js", code: `const tab = await browser.open();\nawait tab.goto("https://example.com/${page}");` },
			});
			const turn = controller.send(
				steps(
					{ update: evalCall("e1", "one") },
					{ update: { ...evalCall("e2", "plain"), rawInput: { code: "1 + 1" } } },
					{ approve: "browser" },
					{ approve: "mcp__x" },
					{ update: evalCall("e3", "three") },
					{ approve: "browser" },
					{ update: evalCall("e1", "one", "completed") },
					{ update: evalCall("e3", "three", "completed") },
					{ approve: "browser" },
				),
			);
			const card = async n => {
				const found = await waitFor(() => posts.slice(seen).filter(m => m.type === "approval")[n], `approval card ${n + 1}`);
				respond(panel, found, "Deny", "Denied");
				return found;
			};
			const only = await card(0);
			assert.deepEqual(only.urls, ["https://example.com/one"], "the one running step that uses the browser");
			assert.equal(only.someUrlsHidden, false);
			assert.match(only.code, /tab\.goto/);
			const otherTool = await card(1);
			assert.equal(otherTool.code, undefined, "another tool's bare prompt borrows no code");
			const two = await card(2);
			assert.equal(two.code, undefined, "with two browser steps running, neither is guessed");
			assert.equal(two.unclear, true);
			const none = await card(3);
			assert.equal(none.code, undefined, "a finished step's code is not shown");
			assert.equal(none.unclear, false);
			await turn;
		},

		async "a hidden session that needs an answer marks its tab and doesn't cover another session"() {
			const [first, second] = api.sessions.all;
			first.panel.reveal();
			await waitFor(() => first.panel.visible && !second.panel.visible, "session 1 in front of session 2");
			const postsTwo = postsOf(second.panel);
			const seenTwo = postsTwo.length;
			const turnTwo = second.controller.send(steps({ permission: "ls" }));
			await waitFor(() => tabLabel(second.panel) === "● OMP 2", "session 2's tab to be marked");
			assert.ok(first.panel.visible, "session 1 stays in front");
			second.panel.reveal();
			await waitFor(() => tabLabel(second.panel) === "OMP 2", "the mark to clear once the tab is seen");
			respond(second.panel, postsTwo.slice(seenTwo).find(m => m.type === "permission"), "allow_once", "Allow once");
			await turnTwo;

			const document = await vscode.workspace.openTextDocument(file("a.txt"));
			await vscode.window.showTextDocument(document, first.panel.viewColumn);
			await waitFor(() => !first.panel.visible && !second.panel.visible, "a file in front of both chats");
			const postsOne = postsOf(first.panel);
			const seenOne = postsOne.length;
			const turnOne = first.controller.send(steps({ permission: "ls" }));
			await waitFor(() => first.panel.visible, "session 1 to come forward, since it covers only a file");
			await waitFor(() => tabLabel(first.panel) === "OMP 1", "no mark on a tab that is in front");
			respond(first.panel, postsOne.slice(seenOne).find(m => m.type === "permission"), "allow_once", "Allow once");
			await turnOne;
		},

		async "a session that finishes while its tab is hidden marks the tab until it is seen"() {
			const [first, second] = api.sessions.all;
			first.panel.reveal();
			await waitFor(() => first.panel.visible && !second.panel.visible, "session 1 in front of session 2");
			assert.equal(tabLabel(second.panel), "OMP 2", "unmarked before its turn");
			await second.controller.send(steps({ say: "done" }));
			await waitFor(() => tabLabel(second.panel) === "● OMP 2", "session 2's tab to be marked");
			await first.controller.send(steps({ say: "done" }));
			assert.equal(tabLabel(first.panel), "OMP 1", "the tab in front is not marked");
			second.panel.reveal();
			await waitFor(() => tabLabel(second.panel) === "OMP 2", "the mark to clear once the tab is seen");
		},

		async "a finished reply chimes once, unless stopped or switched off, and the chime is never replayed"() {
			const panel = api.sessions.all[0].panel;
			const notified = notificationsOf(panel);
			const seen = notified.length;
			const chimes = () => notified.slice(seen).filter(m => m.type === "chime").length;
			const config = vscode.workspace.getConfiguration("omp");
			try {
				await controller.send(steps({ say: "done" }));
				assert.deepEqual(notified.slice(seen), [{ type: "chime" }]);
				const ended = postsOf(panel).filter(m => m.type === "turnEnd").at(-1);
				assert.equal(typeof ended.seconds, "number", "the turn's length goes to the reply's footer");
				assert.ok(!postsOf(panel).some(m => m.type === "chime"), "not kept in the history a reloaded page replays");

				const hung = fakeLog().length;
				const turn = controller.send(steps({ hang: true }));
				await waitFor(() => fakeLog().slice(hung).some(e => e.event === "hang"), "omp to be mid-turn");
				controller.cancel();
				await turn;
				assert.equal(chimes(), 1, "no chime after Stop");

				const sound = () => notified.slice(seen).filter(m => m.type === "sound").at(-1);
				await config.update("soundOnFinish", false, vscode.ConfigurationTarget.Workspace);
				await waitFor(() => sound()?.on === false, "the page to be told to drop the sound");
				await controller.send(steps({ say: "done" }));
				assert.equal(chimes(), 1, "no chime with the setting off");

				await config.update("soundOnFinish", undefined, vscode.ConfigurationTarget.Workspace);
				await waitFor(() => sound()?.on === true, "the page to be told to load the sound again");
				await controller.send(steps({ say: "done" }));
				assert.equal(chimes(), 2, "switched back on: the next finished reply chimes again");
			} finally {
				await config.update("soundOnFinish", undefined, vscode.ConfigurationTarget.Workspace);
			}
		},

		async "messages sent while omp works wait, then go together as the next turn"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const notified = notificationsOf(panel);
			const seen = posts.length;
			const seenNotified = notified.length;
			const logged = fakeLog().length;
			const first = controller.send(steps({ permission: "ls" }));
			const card = await waitFor(() => posts.slice(seen).find(m => m.type === "permission"), "the first turn's card");
			const one = steps({ elicitUrl: "https://one.test" });
			const two = steps({ elicitUrl: "https://two.test" });
			await controller.send(one);
			await controller.send(two);
			const queued = posts.slice(seen).filter(m => m.type === "queued");
			assert.deepEqual(queued.map(m => m.text), [one, two]);
			assert.ok(!posts.slice(seen).some(m => m.type === "notice"), "no 'still working' warning");
			assert.ok(!fakeLog().slice(logged).some(e => e.event === "elicitUrl"), "nothing queued reached omp yet");

			respond(panel, card, "allow_once", "Allow once");
			await first;
			const urls = fakeLog().slice(logged).filter(e => e.event === "elicitUrl").map(e => e.url);
			assert.deepEqual(urls, ["https://one.test", "https://two.test"], "both ran, in order, after the first turn");
			const users = posts.slice(seen).filter(m => m.type === "user").map(m => m.text);
			assert.deepEqual(users.slice(1), [`${one}\n\n${two}`], "as one message");
			const dequeued = posts.slice(seen).find(m => m.type === "dequeued");
			assert.deepEqual(dequeued.ids, queued.map(m => m.id));
			assert.equal(notified.slice(seenNotified).filter(m => m.type === "chime").length, 1, "one chime, after the queued turn");
		},

		async "a queued slash command runs as its own turn, between the plain messages around it"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const seen = posts.length;
			const logged = fakeLog().length;
			const first = controller.send(steps({ permission: "ls" }));
			const card = await waitFor(() => posts.slice(seen).find(m => m.type === "permission"), "the first turn's card");
			const one = steps({ elicitUrl: "https://one.test" });
			const two = steps({ elicitUrl: "https://two.test" });
			const three = steps({ elicitUrl: "https://three.test" });
			for (const text of [one, "/compact", two, three]) await controller.send(text);
			respond(panel, card, "allow_once", "Allow once");
			await first;
			const users = posts.slice(seen).filter(m => m.type === "user").map(m => m.text);
			assert.deepEqual(users.slice(1), [one, "/compact", `${two}\n\n${three}`]);
			const order = fakeLog()
				.slice(logged)
				.filter(e => e.event === "elicitUrl" || e.event === "command")
				.map(e => e.url ?? e.text);
			assert.deepEqual(order, ["https://one.test", "/compact", "https://two.test", "https://three.test"]);
		},

		async "a message sent right after Stop runs next instead of going back to the input"() {
			const panel = api.sessions.all[0].panel;
			const notified = notificationsOf(panel);
			const seenNotified = notified.length;
			const logged = fakeLog().length;
			const turn = controller.send(steps({ hang: true }));
			await waitFor(() => fakeLog().slice(logged).some(e => e.event === "hang"), "omp to be mid-turn");
			controller.cancel();
			await controller.send(steps({ elicitUrl: "https://resent.test" })); // the stopped turn is still finishing
			await turn;
			assert.ok(fakeLog().slice(logged).some(e => e.event === "elicitUrl" && e.url === "https://resent.test"), "the re-sent message reached omp");
			assert.ok(!notified.slice(seenNotified).some(m => m.type === "restoreInput"), "nothing was pushed back into the input");
		},

		async "a turn that ends normally after Stop does not chime"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const notified = notificationsOf(panel);
			const seen = posts.length;
			const seenNotified = notified.length;
			const turn = controller.send(steps({ permission: "ls" }, { say: "finished anyway" }));
			await waitFor(() => posts.slice(seen).find(m => m.type === "permission"), "the card");
			controller.cancel(); // the fake omp then ends its turn with end_turn, like a Stop that lost the race
			await turn;
			assert.equal(posts.slice(seen).find(m => m.type === "turnEnd").stopReason, "end_turn");
			assert.ok(!notified.slice(seenNotified).some(m => m.type === "chime"), "no chime after Stop");
		},

		async "Stop puts queued messages back in the input, and a removed one is never sent"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const notified = notificationsOf(panel);
			const seen = posts.length;
			const seenNotified = notified.length;
			const logged = fakeLog().length;

			let turn = controller.send(steps({ permission: "ls" }));
			const card = await waitFor(() => posts.slice(seen).find(m => m.type === "permission"), "the card");
			await controller.send(steps({ elicitUrl: "https://removed.test" }));
			const removed = posts.slice(seen).find(m => m.type === "queued");
			panel.receive({ type: "unqueue", id: removed.id });
			assert.ok(posts.slice(seen).some(m => m.type === "dequeued" && m.ids.includes(removed.id)));
			respond(panel, card, "allow_once", "Allow once");
			await turn;

			const kept = steps({ elicitUrl: "https://kept.test" });
			const hung = fakeLog().length;
			turn = controller.send(steps({ hang: true }));
			await waitFor(() => fakeLog().slice(hung).some(e => e.event === "hang"), "omp to be mid-turn");
			await controller.send(kept);
			controller.cancel();
			await turn;
			assert.deepEqual(notified.slice(seenNotified).filter(m => m.type === "restoreInput"), [{ type: "restoreInput", text: kept, attachments: [] }]);
			assert.ok(!fakeLog().slice(logged).some(e => e.event === "elicitUrl"), "neither queued message reached omp");
		},

		async "after omp crashes, the next message starts a fresh omp"() {
			const posts = postsOf(api.sessions.all[0].panel);
			await controller.send(steps({ elicitUrl: "https://example.com" }));
			const crashed = fakeLog().at(-1).sessionId;
			const seen = posts.length;
			const logged = fakeLog().length;

			await controller.send(steps({ exit: 1 }));
			const errors = posts.slice(seen).filter(m => m.type === "notice" && m.level === "error");
			assert.equal(errors.length, 1, "the crash is reported once");
			assert.match(errors[0].text, /omp exited \(code 1\)/);
			assert.equal(posts.slice(seen).filter(m => m.type === "status").at(-1).state, "stopped");

			await controller.send(steps({ elicitUrl: "https://example.com" }));
			assert.notEqual(fakeLog().at(-1).sessionId, crashed, "a new omp answered");
			assert.ok(fakeLog().slice(logged).some(e => e.event === "session/new"));
			assert.equal(posts.filter(m => m.type === "status").at(-1).state, "idle");
		},

		async "a diff's title-bar button acts on that diff, even when another one has focus"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("t1.txt"), "a\n");
			fs.writeFileSync(file("t2.txt"), "a\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("t1.txt"), content: "b\n" } }));
			const turnTwo = two.send(steps({ write: { path: file("t2.txt"), content: "b\n" } }));
			const reviewOne = await nextOpenReview(seen, one.id);
			const reviewTwo = await nextOpenReview(seen, two.id);
			await waitFor(() => reviewTabs().length === 2, "both diff tabs");
			await api.reviews.open(reviewOne.id);
			await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.startsWith(`/${reviewOne.id}/`), "session 1's diff to take focus");

			// VS Code calls a title-bar button's command with the address of that editor's file.
			const buttonTarget = reviewTabs().find(tab => tab.input.modified.path.startsWith(`/${reviewTwo.id}/`)).input.modified;
			await vscode.commands.executeCommand("omp.review.rejectAll", buttonTarget);
			await turnTwo;
			const finished = reviews.slice(seen).filter(info => info.state === "done").map(info => info.id);
			assert.deepEqual(finished, [reviewTwo.id], "the button finished its own diff, not the focused one");
			assert.equal(fs.readFileSync(file("t2.txt"), "utf8"), "a\n");

			await vscode.commands.executeCommand("omp.review.acceptAll");
			await turnOne;
			assert.equal(fs.readFileSync(file("t1.txt"), "utf8"), "b\n");
		},

		async "a finished or forgotten review's diff never finishes another session's review"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("o1.txt"), "a\n");
			fs.writeFileSync(file("o2.txt"), "a\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("o1.txt"), content: "b\n" } }));
			const ended = await nextOpenReview(seen, one.id);
			await vscode.commands.executeCommand("omp.review.acceptHunk", ended.id, 0);
			await turnOne;
			const turnTwo = two.send(steps({ write: { path: file("o2.txt"), content: "b\n" } }));
			const live = await nextOpenReview(seen, two.id);
			await waitFor(() => reviewTabs().some(tab => tab.input.modified.path.startsWith(`/${live.id}/`)), "session 2's diff");
			const finished = () => reviews.slice(seen).filter(info => info.state === "done").map(info => info.id);
			const reviewUri = (id, side, name) => vscode.Uri.from({ scheme: "omp-review", path: `/${id}/${side}/${name}` });

			// A review is forgotten a minute after it ends, but Reopen Closed Editor can still bring its diff back.
			api.sessions.all[0].panel.reveal();
			await waitFor(() => !vscode.window.activeTextEditor, "the chat tab to take focus");
			await vscode.commands.executeCommand("omp.review.rejectAll", reviewUri("0", "proposed", "gone.txt"));
			assert.deepEqual(finished(), [ended.id], "a forgotten diff's button decides nothing");

			await vscode.commands.executeCommand("vscode.diff", reviewUri(ended.id, "original", "o1.txt"), reviewUri(ended.id, "proposed", "o1.txt"), "ended");
			await waitFor(() => vscode.window.activeTextEditor?.document.uri.path.startsWith(`/${ended.id}/`), "the finished diff to take focus");
			await vscode.commands.executeCommand("omp.review.acceptAll");
			assert.deepEqual(finished(), [ended.id], "Accept All on a finished diff decides nothing");

			await vscode.window.tabGroups.close(reviewTabs().filter(tab => tab.input.modified.path.startsWith(`/${ended.id}/`)));
			await vscode.commands.executeCommand("omp.review.acceptHunk", live.id, 0);
			await turnTwo;
			assert.equal(fs.readFileSync(file("o2.txt"), "utf8"), "b\n");
		},

		async "with one session's diff open and another session's closed, Accept All from the chat decides nothing"() {
			const [one, two] = api.sessions.all.map(session => session.controller);
			fs.writeFileSync(file("h1.txt"), "a\n");
			fs.writeFileSync(file("h2.txt"), "a\n");
			const seen = reviews.length;
			const turnOne = one.send(steps({ write: { path: file("h1.txt"), content: "b\n" } }));
			const turnTwo = two.send(steps({ write: { path: file("h2.txt"), content: "b\n" } }));
			const reviewOne = await nextOpenReview(seen, one.id);
			const reviewTwo = await nextOpenReview(seen, two.id);
			await waitFor(() => reviewTabs().length === 2, "both diff tabs");
			await vscode.window.tabGroups.close(reviewTabs().filter(tab => tab.input.modified.path.startsWith(`/${reviewTwo.id}/`)));

			api.sessions.all[1].panel.reveal();
			await waitFor(() => !vscode.window.activeTextEditor, "session 2's chat to take focus");
			await vscode.commands.executeCommand("omp.review.acceptAll");
			const finished = reviews.slice(seen).filter(info => info.state === "done");
			assert.deepEqual(finished, [], "session 1's open diff is not taken for session 2's closed one");

			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewOne.id, 0);
			await vscode.commands.executeCommand("omp.review.acceptHunk", reviewTwo.id, 0);
			await Promise.all([turnOne, turnTwo]);
		},

		async "Accept All from the chat counts the diffs that are open, not the front of each queue"() {
			fs.writeFileSync(file("d1.txt"), "a\n");
			fs.writeFileSync(file("d2.txt"), "a\n");
			const seen = reviews.length;
			const turn = controller.send(steps({ writes: ["d1.txt", "d2.txt"].map(name => ({ path: file(name), content: "b\n" })) }));
			await waitFor(() => reviews.slice(seen).length === 2, "one open and one queued review");
			const [front, queued] = reviews.slice(seen);
			const tabOf = info => reviewTabs().find(tab => tab.input.modified.path.startsWith(`/${info.id}/`));
			await waitFor(() => tabOf(front), "the front review's diff");
			const finished = () => reviews.slice(seen).filter(info => info.state === "done").map(info => info.id);
			const focusChat = async () => {
				api.sessions.all[0].panel.reveal();
				await waitFor(() => !vscode.window.activeTextEditor, "the chat tab to take focus");
			};

			await vscode.window.tabGroups.close(tabOf(front));
			await focusChat();
			await vscode.commands.executeCommand("omp.review.acceptAll");
			assert.deepEqual(finished(), [], "with no diff open, nothing is decided");

			await api.reviews.open(front.id);
			await api.reviews.open(queued.id); // what the chat's "Open diff" button does
			await focusChat();
			await vscode.commands.executeCommand("omp.review.acceptAll");
			assert.deepEqual(finished(), [], "with both diffs open, nothing is decided");

			await vscode.window.tabGroups.close(tabOf(front));
			await focusChat();
			await vscode.commands.executeCommand("omp.review.rejectAll");
			assert.deepEqual(finished(), [queued.id], "the one diff still open is the one decided");

			await waitFor(() => tabOf(front), "the front review's diff to reopen");
			await vscode.commands.executeCommand("omp.review.acceptHunk", front.id, 0);
			await turn;
			assert.equal(fs.readFileSync(file(front.displayPath), "utf8"), "b\n");
			assert.equal(fs.readFileSync(file(queued.displayPath), "utf8"), "a\n");
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

		async "Stop while omp is still starting sends nothing and does not chime"() {
			const config = vscode.workspace.getConfiguration("omp");
			const args = config.get("extraArgs");
			await config.update("extraArgs", [...args, "--init-delay", "1000"], vscode.ConfigurationTarget.Workspace);
			try {
				const session = await newSession();
				const notified = notificationsOf(session.panel);
				const logged = fakeLog().length;
				const turn = session.controller.send(steps({ elicitUrl: "https://late.test" }));
				session.controller.cancel(); // omp is still in its 1s startup
				await turn;
				await waitFor(() => fakeLog().slice(logged).some(e => e.event === "session/new"), "omp to finish starting");
				assert.ok(!fakeLog().slice(logged).some(e => e.event === "elicitUrl"), "the stopped message never reached omp");
				assert.ok(!notified.some(m => m.type === "chime"));
				session.panel.dispose();
			} finally {
				await config.update("extraArgs", args, vscode.ConfigurationTarget.Workspace);
			}
		},

		async "a saved chat is picked from the list and continued in its own tab, with the conversation so far"() {
			const pickFirst = async () => {
				const picking = vscode.commands.executeCommand("omp.openPreviousChat");
				await waitFor(() => fakeLog().slice(logged).filter(e => e.event === "session/list").length > lists, "the saved chats to be listed");
				lists++;
				await sleep(500); // let the list appear
				await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
				await picking;
			};
			const logged = fakeLog().length;
			let lists = 0;
			const before = api.sessions.all.length;
			// The new tab's replay can arrive before the test sees the tab, so record every tab's posts from now on.
			const ChatPanel = api.sessions.all[0].panel.constructor;
			const post = ChatPanel.prototype.post;
			const posted = [];
			ChatPanel.prototype.post = function (message) {
				posted.push({ panel: this, message });
				return post.call(this, message);
			};
			try {
				await pickFirst();
				const resumed = await waitFor(() => api.sessions.all.find(s => s.panel.chatTitle === "Fix the parser"), "the saved chat's tab");
				await waitFor(() => allTabs().some(tab => tab.label === `${resumed.panel.label}: Fix the parser`), "its tab to show its name");
				await waitFor(() => fakeLog().slice(logged).some(e => e.event === "session/load" && e.sessionId === "saved-1"), "omp to load the saved chat");
				await waitFor(() => posted.some(p => p.panel === resumed.panel && p.message.type === "status" && p.message.state === "idle"), "the load to finish");
				assert.equal(resumed.controller.sessionId, "saved-1");
				const updates = posted.filter(p => p.panel === resumed.panel && p.message.type === "update").map(p => p.message.update.sessionUpdate);
				assert.deepEqual(updates.slice(0, 4), ["user_message_chunk", "user_message_chunk", "agent_message_chunk", "tool_call"], "the conversation so far is replayed into the tab");

				await resumed.controller.send(steps({ say: "continuing" }));
				const prompt = fakeLog().slice(logged).filter(e => e.event === "prompt").at(-1);
				assert.equal(prompt.promptSessionId, "saved-1", "the next message continues the saved chat");

				await pickFirst();
				assert.equal(api.sessions.all.length, before + 1, "picking it again brings its tab forward instead of opening another");
				resumed.panel.dispose();
			} finally {
				ChatPanel.prototype.post = post;
			}
		},

		async "omp names a new chat after its first reply, and an untitled saved chat when it is opened"() {
			const session = await newSession();
			const posts = postsOf(session.panel);
			const logged = fakeLog().length;
			await session.controller.send(steps({ say: "hi" })); // omp finds nothing to name yet
			assert.equal(session.panel.chatTitle, undefined);
			await session.controller.send(steps({ say: "hello" }, { nameOnRename: "Parser fix" })); // asked again after this reply
			assert.equal(session.panel.chatTitle, "Parser fix");
			const states = posts.filter(m => m.type === "status").map(m => m.state);
			assert.deepEqual(states.slice(-4), ["busy", "idle", "naming", "idle"], "the chat says it is being named, then Ready");
			await waitFor(() => allTabs().some(tab => tab.label === `${session.panel.label}: Parser fix`), "the tab to show the name");
			assert.ok(
				!posts.some(m => m.type === "update" && String(m.update.content?.text ?? "").includes("Session renamed")),
				"omp's 'Session renamed to …' reply stays out of the chat",
			);
			await session.controller.send(steps({ say: "again", nameOnRename: "Should not be used" }));
			assert.equal(fakeLog().slice(logged).filter(e => e.event === "rename").length, 1, "a chat is named once");
			assert.equal(session.panel.chatTitle, "Parser fix");
			session.panel.dispose();

			const old = api.sessions.openSaved({ sessionId: "untitled-1", cwd: root, title: "", _meta: { messageCount: 2 } });
			await waitFor(() => old.panel.chatTitle === "Named on open", "the untitled chat to be named when opened");
			old.panel.dispose();
		},

		async "Stop works while omp names a chat: queued messages go back to the input, and it is named after a later reply"() {
			const session = await newSession();
			const posts = postsOf(session.panel);
			const notified = [];
			const notify = session.panel.notify.bind(session.panel);
			session.panel.notify = message => (notified.push(message), notify(message));
			const turn = session.controller.send(steps({ say: "hi" }, { nameOnRename: "Named later", renameDelay: 5000 }));
			await waitFor(() => posts.some(m => m.type === "status" && m.state === "naming"), "omp to start naming the chat");
			await session.controller.send("typed while naming");
			assert.ok(posts.some(m => m.type === "queued" && m.text === "typed while naming"));
			session.controller.cancel();
			await turn;
			assert.equal(posts.filter(m => m.type === "status").at(-1).state, "idle", "Ready again");
			assert.ok(notified.some(m => m.type === "restoreInput" && m.text === "typed while naming"), "the queued message is back in the input");
			assert.equal(session.panel.chatTitle, undefined, "not named: it was stopped");
			await session.controller.send(steps({ say: "more" }, { nameOnRename: "Named later", renameDelay: 1 }));
			assert.equal(session.panel.chatTitle, "Named later", "asked again after the next reply");
			session.panel.dispose();
		},

		async "messages typed while a saved chat loads and then while it is named go to omp in the order typed"() {
			const logged = fakeLog().length;
			const chat = api.sessions.openSaved({ sessionId: "untitled-slow-2", cwd: root, title: "", _meta: { messageCount: 2 } });
			const posts = postsOf(chat.panel);
			await chat.controller.send(steps({ say: "reply to A" })); // A: while it loads
			await waitFor(() => fakeLog().slice(logged).some(e => e.event === "session/load"), "omp to load the saved chat");
			await sleep(300); // loaded, and the (slow) naming is under way
			await chat.controller.send(steps({ say: "reply to B" })); // B: while it is named
			assert.equal(posts.filter(m => m.type === "queued").length, 2, "B waits behind A");
			await waitFor(() => posts.some(m => m.type === "turnEnd"), "the turn");
			const prompts = fakeLog().slice(logged).filter(e => e.event === "prompt");
			assert.equal(prompts.length, 1, "A and B go together, as one turn");
			const sent = posts.find(m => m.type === "user").text;
			assert.ok(sent.indexOf("reply to A") < sent.indexOf("reply to B"), `in the order typed (${sent})`);
			const replies = posts.filter(m => m.type === "update" && /reply to/.test(m.update.content?.text ?? "")).map(m => m.update.content.text);
			assert.deepEqual(replies, ["reply to A", "reply to B"]);
			chat.panel.dispose();
		},

		async "a saved chat that keeps failing to load says so on every try"() {
			const flaky = api.sessions.openSaved({ sessionId: "flaky-1", cwd: root, title: "Flaky chat", _meta: { messageCount: 2 } });
			const posts = postsOf(flaky.panel);
			const errors = () => posts.filter(m => m.type === "notice" && /rate limited/.test(m.text)).length;
			await waitFor(() => errors() === 1, "the first failure");
			await flaky.controller.send(steps({ say: "try" }));
			await waitFor(() => errors() === 2, "the retry's failure to be reported too, not dropped as a repeat");
			assert.equal(flaky.panel.chatTitle, "Flaky chat", "a chat that failed for another reason than 'not found' is kept");
			assert.equal(flaky.controller.sessionId, "flaky-1");
			flaky.panel.dispose();
		},

		async "a message sent while a saved chat loads and is named goes after its conversation, and its reply is shown"() {
			const logged = fakeLog().length;
			const old = api.sessions.openSaved({ sessionId: "untitled-slow", cwd: root, title: "", _meta: { messageCount: 2 } });
			const posts = postsOf(old.panel);
			await waitFor(() => fakeLog().slice(logged).some(e => e.event === "session/load"), "omp to load the saved chat");
			await sleep(300); // the load has finished and the (slow) naming is under way
			await old.controller.send(steps({ say: "answer to the new message" }));
			await waitFor(() => posts.some(m => m.type === "turnEnd"), "the reply");

			const events = fakeLog().slice(logged).map(e => e.event);
			assert.ok(events.indexOf("rename") < events.indexOf("prompt"), `the message waits for the naming (${events.join(", ")})`);
			assert.equal(old.panel.chatTitle, "Named slowly");
			const shown = posts.filter(m => m.type === "user" || (m.type === "update" && m.update.content?.type === "text")).map(m => m.type === "user" ? "user" : m.update.content.text);
			assert.ok(shown.indexOf("user") > shown.indexOf("It skips **empty** lines."), `the new message comes after the replayed conversation (${shown.join(" | ")})`);
			assert.ok(shown.includes("answer to the new message"), "the reply is not hidden as omp's naming reply");
			old.panel.dispose();

			const typedAtOnce = api.sessions.openSaved({ sessionId: "saved-2", cwd: root, title: "Old chat", _meta: { messageCount: 2 } });
			const typedPosts = postsOf(typedAtOnce.panel);
			await typedAtOnce.controller.send(steps({ say: "ok", nameOnRename: "Should not replace Old chat" })); // before omp has even started
			assert.equal(typedPosts.find(m => m.type === "queued" || m.type === "user")?.type, "queued", "shown as queued at once, while the chat loads");
			await waitFor(() => typedPosts.some(m => m.type === "turnEnd"), "the message to be sent once the chat has loaded");
			assert.equal(typedAtOnce.panel.chatTitle, "Old chat", "a saved chat's name is kept");
			assert.ok(!typedPosts.some(m => m.type === "status" && m.state === "naming"), "omp is not asked to name a chat that has a name");
			const order = typedPosts.filter(m => m.type === "user" || m.type === "update").map(m => m.type === "user" ? "user" : m.update.sessionUpdate);
			assert.ok(order.indexOf("user") > order.indexOf("tool_call"), `the new message follows the whole replay (${order.join(", ")})`);
			typedAtOnce.panel.dispose();
		},

		async "a saved chat omp can no longer open does not block the tab: the next message starts a new chat"() {
			const logged = fakeLog().length;
			const gone = api.sessions.openSaved({ sessionId: "missing-1", cwd: root, title: "Deleted chat", _meta: { messageCount: 2 } });
			const posts = postsOf(gone.panel);
			await gone.controller.send(steps({ say: "first" }));
			await waitFor(
				() => posts.some(m => m.type === "notice" && /could not open this saved chat.*ACP session not found.*next message starts a new chat/s.test(m.text)),
				"the notice that the chat can't be opened",
			);
			await gone.controller.send(steps({ say: "second" }));
			const events = fakeLog().slice(logged).map(e => e.event);
			assert.deepEqual(events.filter(e => e === "session/load"), ["session/load"], "the missing chat is tried once");
			assert.ok(events.includes("session/new") && events.at(-1) === "prompt", "the second message runs in a new chat");
			assert.equal(gone.panel.chatTitle, undefined);
			gone.panel.dispose();
		},

		async "omp exiting while it names a new chat puts a queued message back in the input, not into a fresh chat"() {
			const session = await newSession();
			const posts = postsOf(session.panel);
			const notified = notificationsOf(session.panel);
			const turn = session.controller.send(steps({ say: "hi" }, { crashOnRename: true, renameDelay: 1500 }));
			await waitFor(() => posts.some(m => m.type === "status" && m.state === "naming"), "the chat to be named");
			const naming = fakeLog().length;
			await session.controller.send("now delete the old files");
			await turn;
			await sleep(500); // a fresh omp would have started by now
			assert.ok(notified.some(m => m.type === "restoreInput" && m.text === "now delete the old files"), "the message is back in the input");
			assert.ok(!fakeLog().slice(naming).some(e => e.event === "session/new"), "no fresh omp was started for it");
			assert.equal(posts.filter(m => m.type === "status").at(-1).state, "stopped");
			session.panel.dispose();
		},

		async "omp exiting while it names a saved chat on opening leaves the tab stopped, and the chat still to load"() {
			const crashing = api.sessions.openSaved({ sessionId: "untitled-crash", cwd: root, title: "", _meta: { messageCount: 2 } });
			const posts = postsOf(crashing.panel);
			const replayed = () => posts.filter(m => m.type === "update" && m.update.sessionUpdate === "user_message_chunk").length;
			const crashNotices = () => posts.filter(m => m.type === "notice" && /omp stopped while opening this chat/.test(m.text)).length;
			await crashing.controller.send(steps({ say: "hello" }));
			await waitFor(() => crashNotices() >= 1, "the notice that omp stopped");
			await waitFor(() => posts.filter(m => m.type === "status").at(-1).state === "stopped", "the tab to show Stopped, not Working…");
			assert.equal(crashing.controller.sessionId, "untitled-crash", "the next message loads the saved chat again");
			const shown = replayed();
			assert.ok(shown > 0);
			const logged = fakeLog().length;
			const notified = [];
			const notify = crashing.panel.notify.bind(crashing.panel);
			crashing.panel.notify = message => (notified.push(message), notify(message));
			await crashing.controller.send(steps({ say: "hello again" })); // this fake crashes again while naming
			await waitFor(() => fakeLog().slice(logged).some(e => e.event === "session/load"), "the saved chat to be loaded again");
			await waitFor(() => posts.filter(m => m.type === "status").at(-1).state === "stopped", "the second attempt to end");
			assert.equal(replayed(), shown, "the conversation already shown is not replayed a second time");
			assert.ok(!posts.some(m => m.type === "user" && m.text.includes("hello again")), "a message that was never sent is not shown as sent");
			assert.ok(posts.some(m => m.type === "queued" && m.text.includes("hello again")), "it showed as queued while the chat loaded again");
			assert.ok(notified.some(m => m.type === "restoreInput" && m.text.includes("hello again")), "it goes back to the input, to send again");
			crashing.panel.dispose();
		},

		async "an MCP server added from the extension goes into the project's omp config, and new chats give it to omp"() {
			const config = file(path.join(".omp", "mcp.json"));
			try {
				const written = await vscode.commands.executeCommand("omp.addMcpServer", {
					scope: "project",
					name: "added-here",
					server: { type: "stdio", command: "npx", args: ["-y", "some-mcp-server"], env: {} },
				});
				assert.equal(written, config);
				assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")).mcpServers["added-here"], { command: "npx", args: ["-y", "some-mcp-server"] });
				assert.ok(!fs.existsSync(file(".mcp.json")), "Claude Code's .mcp.json is left alone");
				const logged = fakeLog().length;
				const session = await newSession();
				const started = await waitFor(() => fakeLog().slice(logged).find(e => e.event === "session/new"), "the new chat's omp to start");
				assert.ok(started.mcpServers.includes("added-here"), `omp gets the new server (${started.mcpServers.join(", ")})`);
				session.panel.dispose();

				// The guided way: what kind, the web address, where, the name (suggested), one header, then done.
				const picks = [items => items.find(item => item.type === "http"), items => items.find(item => item.scope === "project")];
				const inputs = ["https://mcp.example-tools.com/mcp", undefined, "Authorization: Bearer ${TOOLS_TOKEN}", ""];
				const asked = [];
				const { showQuickPick, showInputBox, showInformationMessage, showErrorMessage } = vscode.window;
				vscode.window.showQuickPick = async items => picks.shift()(await items);
				vscode.window.showInputBox = async options => {
					asked.push(options);
					const answer = inputs.shift();
					const value = answer === undefined ? options.value : answer; // undefined: keep the suggestion
					assert.equal(await options.validateInput?.(value), undefined, `"${value}" is accepted`);
					return value;
				};
				vscode.window.showInformationMessage = async () => undefined;
				try {
					await vscode.commands.executeCommand("omp.addMcpServer");
				} finally {
					Object.assign(vscode.window, { showQuickPick, showInputBox, showInformationMessage });
				}
				assert.equal(asked[1].value, "example-tools", "the name is suggested from the address");
				assert.ok(asked[0].validateInput("not a url"), "a web address is required");
				// From the chat tab's menu, VS Code passes the tab's address: the questions are still asked.
				let opened = false;
				vscode.window.showQuickPick = async () => ((opened = true), undefined); // then cancelled
				const errors = [];
				vscode.window.showErrorMessage = async message => (errors.push(message), undefined);
				try {
					await vscode.commands.executeCommand("omp.addMcpServer", vscode.Uri.parse("webview-panel://omp.chatPanel"));
				} finally {
					Object.assign(vscode.window, { showQuickPick, showErrorMessage });
				}
				assert.ok(opened, "the questions open");
				assert.deepEqual(errors, [], "no error");

				assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")).mcpServers["example-tools"], {
					type: "http",
					url: "https://mcp.example-tools.com/mcp",
					headers: { Authorization: "Bearer ${TOOLS_TOKEN}" },
				});
			} finally {
				fs.rmSync(file(".omp"), { recursive: true, force: true });
			}
		},

		async "after omp exits in a saved chat, the fresh session that replaces it drops the old name"() {
			const logged = fakeLog().length;
			const old = api.sessions.openSaved({ sessionId: "saved-3", cwd: root, title: "Crashed chat", _meta: { messageCount: 2 } });
			const posts = postsOf(old.panel);
			await old.controller.send(steps({ exit: 1 })); // queued while the chat loads, then sent
			await waitFor(() => posts.some(m => m.type === "notice" && /omp exited/.test(m.text)), "omp to exit");
			await waitFor(() => posts.filter(m => m.type === "status").at(-1)?.state === "stopped", "the tab to show Stopped");
			assert.equal(old.panel.chatTitle, "Crashed chat");
			await old.controller.send(steps({ say: "fresh start" }));
			assert.ok(fakeLog().slice(logged).some(e => e.event === "session/new"), "a new session was opened");
			assert.equal(old.panel.chatTitle, undefined, "the old chat's name is not kept for the new one");
			old.panel.dispose();
		},

		async "a saved chat whose loading crashed partway is not shown twice when it loads again"() {
			const session = api.sessions.openSaved({ sessionId: "crash-midload", cwd: root, title: "Half loaded", _meta: { messageCount: 2 } });
			const posts = postsOf(session.panel);
			const replayed = () => posts.filter(m => m.type === "update" && m.update.sessionUpdate === "user_message_chunk").length;
			await waitFor(() => posts.filter(m => m.type === "status").at(-1)?.state === "stopped", "omp to exit while loading");
			const shown = replayed();
			assert.ok(shown > 0, "part of the conversation was shown before omp exited");
			const logged = fakeLog().length;
			await session.controller.send(steps({ say: "after" })); // waits in the queue while the chat loads again
			await waitFor(() => fakeLog().slice(logged).some(e => e.event === "session/load" && e.sessionId === "crash-midload"), "the chat to load again");
			await waitFor(() => posts.some(m => m.type === "turnEnd"), "the message to run in the reloaded chat");
			assert.equal(replayed(), shown, "its conversation was not added a second time");
			session.panel.dispose();
		},

		async "a command omp runs in another folder says which folder on its permission card"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const seen = posts.length;
			const turn = controller.send(steps({ permission: "ls -la", cwd: "vendor/lib" }));
			const card = await waitFor(() => posts.slice(seen).find(m => m.type === "permission"), "the card");
			assert.equal(card.cwd, "vendor/lib");
			respond(panel, card, "reject_once", "Reject");
			await turn;
		},

		// Last but one: it leaves read-only commands auto-allowed in session 1, which no later test expects.
		async "\"Always allow read-only commands\" auto-allows only read-only commands, for this chat only"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const cards = () => posts.slice(seen).filter(m => m.type === "permission");
			const answered = () => fakeLog().slice(logged).filter(e => e.event === "permission").map(e => e.result.outcome.optionId);
			const seen = posts.length;
			const logged = fakeLog().length;

			const writeCommand = controller.send(steps({ permission: "rm -rf build" }));
			const writeCard = await waitFor(() => cards()[0], "the card for a command that writes");
			assert.deepEqual(writeCard.options.map(o => o.name), ["Allow once", "Reject"], "no 'always' for every command either way, and no read-only option");
			respond(panel, writeCard, "reject_once", "Reject");
			await writeCommand;

			const first = controller.send(steps({ permission: "ls -la" }));
			const readCard = await waitFor(() => cards()[1], "the card for a read-only command");
			assert.deepEqual(readCard.options.map(o => o.name), ["Allow once", "Always allow read-only commands", "Reject"]);
			respond(panel, readCard, readCard.options[1].optionId, "Always allow read-only commands");
			await first;
			assert.equal(answered().at(-1), "allow_once", "omp is only ever told 'allow once'");

			await controller.send(steps({ permission: "cd src && grep -rn \"a\\|b\" . | head" }));
			assert.equal(cards().length, 2, "a later read-only command asks nothing");
			assert.equal(answered().at(-1), "allow_once");
			assert.ok(posts.slice(seen).some(m => m.type === "autoAllowed"), "and its row says it was allowed automatically");

			const write = controller.send(steps({ permission: "echo hi > notes.md" }));
			const asked = await waitFor(() => cards()[2], "a command that writes still asks");
			respond(panel, asked, "reject_once", "Reject");
			await write;

			const second = await newSession();
			const secondPosts = postsOf(second.panel);
			const before = secondPosts.length;
			const other = second.controller.send(steps({ permission: "ls" }));
			const otherCard = await waitFor(() => secondPosts.slice(before).find(m => m.type === "permission"), "another chat still asks");
			respond(second.panel, otherCard, "allow_once", "Allow once");
			await other;
			second.panel.dispose();
		},

		async "attached files reach omp as text (unsaved changes included), images and paths"() {
			const panel = api.sessions.all[0].panel;
			const notes = notificationsOf(panel);
			const seen = notes.length;
			fs.writeFileSync(file("att.ts"), "saved\n");
			fs.writeFileSync(file("shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]));
			fs.mkdirSync(file("assets"), { recursive: true });
			const document = await vscode.workspace.openTextDocument(file("att.ts"));
			const edit = new vscode.WorkspaceEdit();
			edit.replace(document.uri, new vscode.Range(0, 0, 1, 0), "unsaved\n");
			await vscode.workspace.applyEdit(edit);

			// As the page sends them: an address from the Explorer, a plain path, a folder; then a pasted file.
			panel.receive({ type: "attachUris", uris: [document.uri.toString(), file("shot.png"), vscode.Uri.file(file("assets")).toString()] });
			panel.receive({ type: "attachData", name: "notes.txt", data: Buffer.from("pasted text").toString("base64") });
			const attached = await waitFor(() => {
				const chips = notes.slice(seen).filter(m => m.type === "attached").map(m => m.attachment);
				return chips.length === 4 && chips;
			}, "four attachments");
			assert.deepEqual(attached.map(chip => [chip.kind, chip.name, chip.path]), [
				["text", "att.ts", "att.ts"],
				["image", "shot.png", "shot.png"],
				["path", "assets", "assets"],
				["text", "notes.txt", undefined],
			]);
			assert.ok(attached[1].thumbnail.startsWith("data:image/png;base64,"));

			const logged = fakeLog().length;
			panel.receive({ type: "send", text: "look at these", attachments: attached.map(chip => chip.id) });
			const entry = await waitFor(() => fakeLog().slice(logged).find(e => e.event === "attachments"), "the prompt to reach omp");
			assert.deepEqual(entry.prompt, [
				{ type: "text", text: "look at these" },
				{ type: "text", text: '<attached-file path="att.ts">\nunsaved\n</attached-file>' },
				{ type: "text", text: '<attached-file path="shot.png" type="image">\nThe image is attached to this message.\n</attached-file>' },
				{ type: "text", text: '<attached-file path="assets" type="path">\nOnly the path is attached: it is a folder. Read it from disk if you need it.\n</attached-file>' },
				{ type: "text", text: '<attached-file name="notes.txt">\npasted text\n</attached-file>' },
				{ type: "image", data: "iVBORw0KGgoH", mimeType: "image/png" },
			]);
			await document.save();
		},

		async "an Excel file dropped from outside VS Code is saved for omp and sent as a document; closing the chat removes the copy"() {
			const second = await newSession();
			const notes = notificationsOf(second.panel);
			await second.panel.whenReady(); // a file can only be dropped on a page that has loaded
			const bytes = Buffer.from("PK\u0003\u0004 not really a workbook");
			second.panel.receive({ type: "attachData", name: "WBSO Urenregistratie 2026.xlsx", data: bytes.toString("base64") });
			const chip = await waitFor(() => notes.find(m => m.type === "attached")?.attachment, "the workbook's chip");
			assert.equal(chip.kind, "document");
			assert.ok(path.isAbsolute(chip.path) && chip.path.endsWith(`${path.sep}WBSO Urenregistratie 2026.xlsx`), chip.path);
			assert.deepEqual(fs.readFileSync(chip.path), bytes, "the copy omp reads is the dropped file");
			assert.match(chip.note, /a copy is saved for omp/);
			assert.ok(chip.path.startsWith(second.controller.copiesDir + path.sep), "in the extension's own storage, not a shared temp folder");
			if (process.platform !== "win32") {
				assert.equal(fs.statSync(path.dirname(chip.path)).mode & 0o077, 0, "only this user may open the folder");
				assert.equal(fs.statSync(chip.path).mode & 0o077, 0, "or read the copy");
			}

			const logged = fakeLog().length;
			second.panel.receive({ type: "send", text: "add up the hours", attachments: [chip.id] });
			const entry = await waitFor(() => fakeLog().slice(logged).find(e => e.event === "attachments"), "the prompt to reach omp");
			assert.deepEqual(entry.prompt.map(block => block.text), [
				"add up the hours",
				`<attached-file path="${chip.path}" type="document">\nAn Excel workbook: its text is not included here. Read it with your read tool, which converts it to text, before you answer.\n</attached-file>`,
			]);
			second.panel.dispose();
			await waitFor(() => !fs.existsSync(path.dirname(path.dirname(chip.path))), "the chat's copies to be removed");
		},

		async "Attach to OMP Chat in the Explorer's menu attaches every selected file"() {
			const panel = api.sessions.active.panel;
			const notes = notificationsOf(panel);
			const seen = notes.length;
			fs.writeFileSync(file("menu-a.ts"), "a\n");
			fs.writeFileSync(file("menu-b.ts"), "b\n");
			const [a, b] = ["menu-a.ts", "menu-b.ts"].map(name => vscode.Uri.file(file(name)));
			await vscode.commands.executeCommand("omp.attachToChat", a, [a, b]); // as the Explorer calls it: the clicked file, then the selection
			const chips = await waitFor(() => {
				const attached = notes.slice(seen).filter(m => m.type === "attached");
				return attached.length === 2 && attached.map(m => m.attachment);
			}, "both selected files");
			assert.deepEqual(chips.map(chip => [chip.kind, chip.path]), [["text", "menu-a.ts"], ["text", "menu-b.ts"]]);
			for (const chip of chips) panel.receive({ type: "detach", id: chip.id });
		},

		async "a queued message keeps its attachments, and Stop puts them back on the input"() {
			const panel = api.sessions.all[0].panel;
			const posts = postsOf(panel);
			const notes = notificationsOf(panel);
			fs.writeFileSync(file("queued.md"), "# notes\n");
			const turn = controller.send(steps({ hang: true }));
			const seenNotes = notes.length;
			panel.receive({ type: "attachUris", uris: [file("queued.md")] });
			const chip = await waitFor(() => notes.slice(seenNotes).find(m => m.type === "attached")?.attachment, "the attachment");
			const seenPosts = posts.length;
			panel.receive({ type: "send", text: "then this", attachments: [chip.id] });
			const queued = await waitFor(() => posts.slice(seenPosts).find(m => m.type === "queued"), "the message to queue");
			assert.deepEqual(queued.attachments.map(c => c.name), ["queued.md"]);

			controller.cancel();
			await turn;
			const restored = await waitFor(() => notes.slice(seenNotes).find(m => m.type === "restoreInput"), "the message to come back");
			assert.equal(restored.text, "then this");
			assert.deepEqual(restored.attachments.map(c => c.id), [chip.id]);

			const logged = fakeLog().length;
			panel.receive({ type: "send", text: "sent again", attachments: [chip.id] });
			const entry = await waitFor(() => fakeLog().slice(logged).find(e => e.event === "attachments"), "the resent prompt");
			assert.deepEqual(entry.prompt.map(block => block.text), ["sent again", '<attached-file path="queued.md">\n# notes\n</attached-file>']);
		},

		async "files each within the budget but over it together: the text that no longer fits goes as its path"() {
			const panel = api.sessions.all[0].panel;
			const notes = notificationsOf(panel);
			const config = vscode.workspace.getConfiguration("omp");
			await config.update("attachments.maxTextTokens", 30, vscode.ConfigurationTarget.Workspace);
			try {
				fs.writeFileSync(file("budget-a.md"), `${"a".repeat(79)}\n`); // 20 tokens each
				fs.writeFileSync(file("budget-b.md"), `${"b".repeat(79)}\n`);
				const turn = controller.send(steps({ hang: true }));
				const chips = [];
				for (const [name, text] of [["budget-a.md", "first"], ["budget-b.md", "second"]]) {
					const seen = notes.length;
					panel.receive({ type: "attachUris", uris: [file(name)] });
					const chip = await waitFor(() => notes.slice(seen).find(m => m.type === "attached")?.attachment, name);
					assert.equal(chip.kind, "text", "on its own, each fits");
					chips.push(chip);
					panel.receive({ type: "send", text, attachments: [chip.id] }); // queued: the input is empty again
				}
				const seen = notes.length;
				controller.cancel();
				await turn;
				const restored = await waitFor(() => notes.slice(seen).find(m => m.type === "restoreInput"), "the queued messages to come back");
				assert.deepEqual(restored.attachments.map(c => c.id), chips.map(c => c.id));

				const logged = fakeLog().length;
				panel.receive({ type: "send", text: restored.text, attachments: chips.map(c => c.id) });
				const entry = await waitFor(() => fakeLog().slice(logged).find(e => e.event === "attachments"), "the prompt to reach omp");
				assert.deepEqual(entry.prompt.map(block => block.text), [
					"first\n\nsecond",
					`<attached-file path="budget-a.md">\n${"a".repeat(79)}\n</attached-file>`,
					'<attached-file path="budget-b.md" type="path">\nOnly the path is attached: it is too large to include (about 20 tokens). Read it from disk if you need it.\n</attached-file>',
				]);
			} finally {
				await config.update("attachments.maxTextTokens", undefined, vscode.ConfigurationTarget.Workspace);
			}
		},

		async "an untitled editor too large to include is saved as a copy and sent as its path"() {
			const panel = api.sessions.all[0].panel;
			const notes = notificationsOf(panel);
			const config = vscode.workspace.getConfiguration("omp");
			await config.update("attachments.maxTextTokens", 10, vscode.ConfigurationTarget.Workspace);
			try {
				const document = await vscode.workspace.openTextDocument({ content: "log line\n".repeat(20) });
				const seen = notes.length;
				panel.receive({ type: "attachUris", uris: [document.uri.toString()] });
				const chip = await waitFor(() => notes.slice(seen).find(m => m.type === "attached")?.attachment, "the editor's chip");
				assert.equal(chip.kind, "path");
				assert.ok(path.isAbsolute(chip.path), chip.path);
				assert.equal(fs.readFileSync(chip.path, "utf8"), document.getText(), "the copy holds the editor's text");
				assert.match(chip.note, /a copy is saved for omp/);
				panel.receive({ type: "detach", id: chip.id });
			} finally {
				await config.update("attachments.maxTextTokens", undefined, vscode.ConfigurationTarget.Workspace);
			}
		},

		async "a file pasted just before the chat closes leaves no copy behind"() {
			const second = await newSession();
			await second.panel.whenReady();
			const copies = second.controller.copiesDir;
			second.panel.receive({ type: "attachData", name: "late.xlsx", data: Buffer.from("PK\u0003\u0004").toString("base64") });
			second.panel.dispose();
			await sleep(1000);
			assert.equal(fs.existsSync(copies), false);
		},

		async "moving a chat into its own window keeps the session working"() {
			const [first] = api.sessions.all;
			let reloads = 0;
			const countReloads = first.panel.onMessage(message => message?.type === "ready" && reloads++);
			try {
				await vscode.commands.executeCommand("omp.openInWindow");
				await waitFor(() => reloads >= 1, "the chat page to reload in its new window");
				assert.ok(api.sessions.all.includes(first), "the session survived the move");

				fs.writeFileSync(file("mv.txt"), "a\n");
				const seen = reviews.length;
				const turn = first.controller.send(steps({ write: { path: file("mv.txt"), content: "b\n" } }));
				const info = await nextOpenReview(seen);
				await vscode.commands.executeCommand("omp.review.acceptHunk", info.id, 0);
				await turn;
				assert.equal(fs.readFileSync(file("mv.txt"), "utf8"), "b\n");
				assert.equal(reloads, 1, "the chat page reloaded once, which replays its history");
			} finally {
				countReloads.dispose();
			}
		},
	};

	for (const [name, test] of Object.entries(tests)) {
		try {
			let timer;
			const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("test took over 30s")), 30_000)));
			await Promise.race([test(), timeout]).finally(() => clearTimeout(timer));
		} catch (error) {
			console.log(`[offline] FAILED: ${name}\nrecent reviews: ${JSON.stringify(reviews.slice(-4))}\nfake omp log tail: ${JSON.stringify(fakeLog().slice(-4))}`);
			throw error;
		}
		console.log(`[offline] ok: ${name}`);
	}
};
