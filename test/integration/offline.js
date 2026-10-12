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
				assert.ok(!postsOf(panel).some(m => m.type === "chime"), "not kept in the history a reloaded page replays");

				const hung = fakeLog().length;
				const turn = controller.send(steps({ hang: true }));
				await waitFor(() => fakeLog().slice(hung).some(e => e.event === "hang"), "omp to be mid-turn");
				controller.cancel();
				await turn;
				assert.equal(chimes(), 1, "no chime after Stop");

				await config.update("soundOnFinish", false, vscode.ConfigurationTarget.Workspace);
				await controller.send(steps({ say: "done" }));
				assert.equal(chimes(), 1, "no chime with the setting off");
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
			assert.deepEqual(notified.slice(seenNotified).filter(m => m.type === "restoreInput"), [{ type: "restoreInput", text: kept }]);
			await sleep(300);
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
				await sleep(300);
				assert.ok(!fakeLog().slice(logged).some(e => e.event === "elicitUrl"), "the stopped message never reached omp");
				assert.ok(!notified.some(m => m.type === "chime"));
				session.panel.dispose();
			} finally {
				await config.update("extraArgs", args, vscode.ConfigurationTarget.Workspace);
			}
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
