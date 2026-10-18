// The chat page (media/chat.js) in a simulated browser: what it shows, and what it sends back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const script = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");
// Loaded first, as on the real page (needs `npm run build`, like the other tests' dist/core.js).
const markdown = fs.readFileSync(path.join(__dirname, "..", "dist", "markdown.js"), "utf8");

const CHIME_SRC = "media/staplebops-01.mp3";

/** The page's markup, as built by chatHtml() in src/chatPanel.ts. */
const BODY = `<div id="log"></div>
<div id="activity" hidden></div>
<div id="queue"></div>
<footer>
  <div id="settings"></div>
  <div id="attachments" hidden></div>
  <textarea id="input"></textarea>
  <div class="row"><button id="attach"></button><span id="status"></span><span id="usage"></span><button id="stop" hidden></button><button id="send"></button></div>
</footer>`;

const windows = [];
test.after(() => {
	for (const window of windows) window.close(); // stops the activity line's timer
});

function openChat(setup = () => {}) {
	const dom = new JSDOM(`<!DOCTYPE html><body data-chime="${CHIME_SRC}">${BODY}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
	const { window } = dom;
	windows.push(window);
	setup(window);
	const posted = [];
	// Copied like the real VS Code bridge does, which also turns them into plain Node objects.
	window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) });
	window.Element.prototype.scrollIntoView = () => {};
	// The bundle is strict, so its top-level `var` stays inside an eval (on the page, a <script>, it is global).
	window.eval(`${markdown}\nwindow.ompMarkdown = ompMarkdown;`);
	window.eval(script);
	return {
		posted,
		log: window.document.getElementById("log"),
		activity: window.document.getElementById("activity"),
		window,
		deliver: (...messages) => {
			for (const data of messages) window.dispatchEvent(new window.MessageEvent("message", { data }));
		},
		nextFrame: () => new Promise(resolve => window.requestAnimationFrame(() => resolve())),
	};
}

const permission = {
	type: "permission",
	requestId: "7",
	title: "Run ls",
	command: "ls",
	options: [
		{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
		{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	],
};
const chunk = text => ({ type: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

test("clicking a permission button sends the answer with its label and locks the question", () => {
	const chat = openChat();
	chat.deliver(permission);
	const ask = chat.log.querySelector(".tool-ask");
	ask.querySelector("button").click();
	assert.deepEqual(chat.posted.at(-1), { type: "respond", requestId: "7", value: "allow_once", label: "Allow once" });
	assert.ok(ask.classList.contains("resolved"));
	assert.ok([...ask.querySelectorAll("button")].every(button => button.disabled));
	assert.equal(ask.querySelector(".card-result").textContent, "Allow once");
});

test("an answered permission stays answered when the chat is replayed", () => {
	const chat = openChat();
	chat.deliver(permission, { type: "resolved", requestId: "7", label: "Allow once" });
	const ask = chat.log.querySelector(".tool-ask");
	assert.ok(ask.classList.contains("resolved"));
	assert.ok([...ask.querySelectorAll("button")].every(button => button.disabled));
	assert.equal(ask.querySelector(".card-result").textContent, "Allow once");
});

test("a permission for a command run in another folder names that folder", () => {
	const chat = openChat();
	chat.deliver({ ...permission, cwd: "vendor/lib" });
	assert.ok([...chat.log.querySelectorAll(".tool-ask .location")].some(node => node.textContent === "in folder: vendor/lib"));
});

test("a command's permission goes inside its tool row, and the command is shown once", () => {
	const chat = openChat();
	const command = "cd /repo && grep -rn foo src | head";
	const tool = status => ({
		type: "update",
		update: { sessionUpdate: status ? "tool_call_update" : "tool_call", toolCallId: "t9", title: command, kind: "execute", status: status ?? "pending", rawInput: { command } },
	});
	chat.deliver(tool(), { ...permission, toolCallId: "t9", command });
	const rows = chat.log.querySelectorAll(".tool");
	assert.equal(rows.length, 1, "one row, no separate card");
	assert.equal(chat.log.querySelectorAll(".card").length, 0);
	const shown = [...rows[0].querySelectorAll(".tool-title, .tool-command, .tool-ask pre")].filter(node => !node.hidden && node.textContent.includes(command));
	assert.equal(shown.length, 1, "the command appears once");
	assert.equal(rows[0].querySelector(".tool-ask .card-heading").textContent, "Run this command?");

	rows[0].querySelector(".tool-ask button").click();
	chat.deliver({ ...tool("completed"), update: { ...tool("completed").update, rawOutput: { content: [{ type: "text", text: "src/a.ts:1:foo" }] } } });
	assert.equal(rows[0].querySelector(".tool-status").textContent, "✓");
	assert.equal(rows[0].querySelector(".tool-output pre").textContent, "src/a.ts:1:foo");
	assert.equal(rows[0].querySelector(".tool-ask .card-result").textContent, "Allow once", "the answer stays visible in the row");
});

test("approval cards send Approve or Deny with a label", () => {
	const chat = openChat();
	chat.deliver({ type: "approval", requestId: "8", toolName: "bash", details: "rm -rf build", warning: "may change files" });
	const card = chat.log.querySelector(".card");
	assert.match(card.querySelector(".warning").textContent, /may change files/);
	card.querySelectorAll("button")[1].click();
	assert.deepEqual(chat.posted.at(-1), { type: "respond", requestId: "8", value: "Deny", label: "Denied" });
});

test("a browser approval lists the addresses in the code, never as the full list, with the full code open", () => {
	const chat = openChat();
	const code = 'await tab.goto("https://example.com/a")';
	const note = card => [...card.querySelectorAll(".field-description")].at(-1).textContent;
	chat.deliver({ type: "approval", requestId: "9", toolName: "browser", details: "", code, urls: ["https://example.com/a"] });
	const card = chat.log.querySelector(".card");
	assert.equal(card.querySelector(".card-heading").textContent, "Allow omp to use the browser?");
	assert.equal(card.querySelector(".field-description").textContent, "Addresses written in the code:");
	assert.equal(card.querySelector(".location").textContent, "🌐 https://example.com/a");
	assert.match(note(card), /may also open pages not listed/, "a found address is never presented as the only page");
	assert.equal(card.querySelector("details").open, true, "the code is open, so it can be checked");
	assert.equal(card.querySelector("details pre").textContent, code);

	const long = "x".repeat(7000);
	chat.deliver({ type: "approval", requestId: "13", toolName: "browser", details: "", code: long, urls: [] });
	const longCard = chat.log.querySelectorAll(".card")[1];
	assert.equal(longCard.querySelector("details pre").textContent, long, "not cut short");
	assert.match(note(longCard), /No address is written in the code/);

	chat.deliver({ type: "approval", requestId: "10", toolName: "browser", details: "" });
	assert.equal(note(chat.log.querySelectorAll(".card")[2]), "omp did not say which page.");

	chat.deliver({ type: "approval", requestId: "11", toolName: "browser", details: "", unclear: true });
	assert.match(note(chat.log.querySelectorAll(".card")[3]), /unclear which page/);

	chat.deliver({ type: "approval", requestId: "12", toolName: "browser", details: "", code, urls: ["https://a.test"], someUrlsHidden: true });
	const mixed = chat.log.querySelectorAll(".card")[4];
	assert.equal(mixed.querySelector(".location").textContent, "🌐 https://a.test");
	assert.match(note(mixed), /built from variables/, "the hidden address is flagged, not silently dropped");
});

test("a streamed reply renders once per frame, with nothing lost", async () => {
	const chat = openChat();
	const words = Array.from({ length: 500 }, (_, i) => `w${i} `);
	chat.deliver(...words.map(chunk));
	const reply = chat.log.querySelectorAll(".msg.assistant");
	assert.equal(reply.length, 1);
	assert.equal(reply[0].textContent, "", "500 chunks caused no render before the frame");
	await chat.nextFrame();
	assert.equal(reply[0].textContent.trim(), words.join("").trim());
});

test("a reply cut by a tool call is rendered in full before the next one starts", async () => {
	const chat = openChat();
	chat.deliver(chunk("Hello "), chunk("there"));
	chat.deliver({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a file", kind: "read" } });
	chat.deliver(chunk("Done"));
	const replies = chat.log.querySelectorAll(".msg.assistant");
	assert.equal(replies[0].textContent.trim(), "Hello there", "the first reply rendered as soon as the second began");
	await chat.nextFrame();
	assert.deepEqual([...replies].map(reply => reply.textContent.trim()), ["Hello there", "Done"]);
});

test("a sent or replayed message of the user's can be put back in the input to edit and resend", () => {
	const chat = openChat();
	const input = chat.window.document.getElementById("input");
	chat.deliver({ type: "user", text: "Fix the parser" });
	chat.deliver({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier question" } } });
	const [sent, replayed] = chat.log.querySelectorAll(".msg.user");
	assert.equal(sent.textContent, "Fix the parser", "the button adds no text to the message");
	sent.querySelector("button.edit").click();
	assert.equal(input.value, "Fix the parser");
	input.value = "";
	replayed.querySelector("button.edit").click();
	assert.equal(input.value, "Earlier question");
	assert.deepEqual(chat.posted.filter(m => m.type === "send"), [], "nothing is sent until the user presses Enter");
});

test("a reply is drawn in full when its turn ends, without waiting for a screen frame", () => {
	const chat = openChat(window => (window.requestAnimationFrame = () => 0)); // a page in the background gets no frames
	chat.deliver(chunk("| a |\n|---|\n| b |"), { type: "turnEnd", stopReason: "end_turn", seconds: 1 });
	assert.equal(chat.log.querySelectorAll(".msg.assistant table tr").length, 2);
});

test("each reply ends with the model and how long the turn took", () => {
	const chat = openChat();
	chat.deliver(chunk("Done."), { type: "turnEnd", stopReason: "end_turn", seconds: 12, model: "GLM 5.3 (Nebul)" });
	chat.deliver(chunk("Done again."), { type: "turnEnd", stopReason: "end_turn", seconds: 135 });
	assert.deepEqual([...chat.log.querySelectorAll(".reply-meta")].map(node => node.textContent), ["GLM 5.3 (Nebul) · 12s", "2m 15s"]);
});

test("context notices: a warning when it gets full, and a note when omp compacts it", () => {
	const chat = openChat();
	const usage = used => ({ type: "update", update: { sessionUpdate: "usage_update", used, size: 100_000 } });
	const notices = () => [...chat.log.querySelectorAll(".notice")].map(node => node.textContent);
	chat.deliver(usage(30_000), usage(60_000));
	assert.deepEqual(notices(), [], "nothing while there is room");
	chat.deliver(usage(85_000), usage(90_000));
	assert.equal(notices().length, 1, "warned once when crossing 80%, not every turn");
	assert.match(notices()[0], /Context 85% full.*\/compact/);
	chat.deliver(usage(20_000));
	assert.match(notices()[1], /omp compacted the conversation .*now 20% full/);
	chat.deliver(usage(83_000));
	assert.match(notices()[2], /Context 83% full/, "warned again after filling up again");
	assert.equal(chat.window.document.getElementById("usage").textContent, "83% context");
});

test("a new omp session's lower context use is not taken for a compaction", () => {
	const chat = openChat();
	const usage = used => ({ type: "update", update: { sessionUpdate: "usage_update", used, size: 100_000 } });
	const notices = () => [...chat.log.querySelectorAll(".notice")].map(node => node.textContent);
	chat.deliver(usage(70_000), { type: "status", state: "stopped" }, { type: "status", state: "starting" }, usage(3_000));
	assert.deepEqual(notices(), [], "omp restarted with a fresh session: nothing was compacted");
	chat.deliver(usage(85_000), { type: "status", state: "starting" }, usage(90_000));
	assert.equal(notices().length, 2, "the 'nearly full' warning is given again for the new session");
});

test("a saved chat's replayed messages show as the user's and omp's messages", async () => {
	const chat = openChat();
	const user = text => ({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
	chat.deliver(user("Why does the parser "), user("fail?"), chunk("It skips **empty** lines."), user("Fix it"), chunk("Done."));
	await chat.nextFrame();
	const messages = [...chat.log.querySelectorAll(".msg")].map(node => [node.classList.contains("user") ? "user" : "omp", node.textContent.trim()]);
	assert.deepEqual(messages, [
		["user", "Why does the parser fail?"],
		["omp", "It skips empty lines."],
		["user", "Fix it"],
		["omp", "Done."],
	]);
});

test("two replayed user messages in a row stay two messages", async () => {
	const chat = openChat();
	const user = (text, messageId) => ({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId } });
	chat.deliver(user("fix the ", "m1"), user("bug", "m1"), user("also add tests", "m2"), user("and docs"), chunk("Done."));
	await chat.nextFrame();
	const messages = [...chat.log.querySelectorAll(".msg")].map(node => node.textContent.trim());
	assert.deepEqual(messages, ["fix the bug", "also add tests", "and docs", "Done."], "a chunk without a messageId is another message too, as in the stored history");
});

test("the chat shows when omp is naming it", () => {
	const chat = openChat();
	chat.deliver({ type: "status", state: "naming" });
	assert.equal(chat.window.document.getElementById("status").textContent, "Naming the chat…");
	assert.equal(chat.window.document.getElementById("stop").hidden, false, "naming can be stopped");
	chat.deliver({ type: "status", state: "idle" });
	assert.equal(chat.window.document.getElementById("stop").hidden, true);
});

test("HTML written in a reply is shown as text, and the markdown around it still renders", async () => {
	const chat = openChat();
	chat.deliver(
		chunk("Wrap it in a <form> with an <input>, never a <script>alert(1)</script>, and **bold** this.\n\n<div>\n*still markdown*\n</div>\n\n| a | b |\n|---|---|\n| x<br>y | `<b>` |"),
	);
	await chat.nextFrame();
	const reply = chat.log.querySelector(".msg.assistant");
	assert.equal(reply.querySelector("form, input, script, div"), null, "no real form, input, script or div");
	assert.match(reply.textContent, /Wrap it in a <form> with an <input>, never a <script>alert\(1\)<\/script>, and bold this\./);
	assert.equal(reply.querySelector("strong").textContent, "bold");
	assert.equal(reply.querySelector("em").textContent, "still markdown", "a line starting with a tag is still markdown");
	assert.match(reply.textContent, /<div>/);
	assert.equal(reply.querySelector("td").innerHTML, "x<br>y", "<br> in a table cell is a line break");
	assert.equal(reply.querySelectorAll("td")[1].textContent, "<b>");
});

test("single newlines in a reply are line breaks", async () => {
	const chat = openChat();
	chat.deliver(chunk("Step one: build\nStep two: test\nStep three: ship"));
	await chat.nextFrame();
	const paragraph = chat.log.querySelector(".msg.assistant p");
	assert.equal(paragraph.querySelectorAll("br").length, 2);
});

test("a reply's markdown table, list, code and link render as such", async () => {
	const chat = openChat();
	chat.deliver(chunk("| # | Finding |\n|---|---|\n| 1 | **Real** bug |\n| 2 | `code` |\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\nSee [docs](https://example.com/docs)."));
	await chat.nextFrame();
	const reply = chat.log.querySelector(".msg.assistant");
	const cells = [...reply.querySelectorAll("table tr")].map(row => [...row.children].map(cell => cell.textContent));
	assert.deepEqual(cells, [["#", "Finding"], ["1", "Real bug"], ["2", "code"]]);
	assert.equal(reply.querySelector("td strong").textContent, "Real");
	assert.deepEqual([...reply.querySelectorAll("ul li")].map(li => li.textContent), ["one", "two"]);
	assert.equal(reply.querySelector("pre code").textContent, "const x = 1;\n");
	assert.equal(reply.querySelector("a").getAttribute("href"), "https://example.com/docs");
});

test("a code block in a reply has a Copy button that copies just the code", async () => {
	const copied = [];
	const chat = openChat(window => {
		Object.defineProperty(window.navigator, "clipboard", { value: { writeText: text => (copied.push(text), Promise.resolve()) } });
	});
	chat.deliver(chunk("Run:\n\n```sh\nnpm test\n```"));
	await chat.nextFrame();
	const button = chat.log.querySelector(".msg.assistant pre button.copy");
	button.click();
	await Promise.resolve();
	assert.deepEqual(copied, ["npm test\n"]);
	assert.equal(button.textContent, "Copied");
});

test("when the clipboard API refuses (page not focused), the code is copied with the copy command", async () => {
	const commands = [];
	const chat = openChat(window => {
		Object.defineProperty(window.navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("Document is not focused")) } });
		window.document.execCommand = command => {
			commands.push([command, window.document.querySelector("body > textarea")?.value]);
			return true;
		};
	});
	chat.deliver(chunk("```\nls\n```"));
	await chat.nextFrame();
	const button = chat.log.querySelector("pre button.copy");
	button.click();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(commands, [["copy", "ls\n"]]);
	assert.equal(button.textContent, "Copied");
});

test("a reply's markdown cannot run script or inject handlers", async () => {
	const chat = openChat();
	chat.deliver(chunk('Hi <script>window.hacked = 1</script><img src=x onerror="window.hacked = 2"> [x](javascript:alert(1))'));
	await chat.nextFrame();
	const reply = chat.log.querySelector(".msg.assistant");
	assert.equal(reply.querySelector("script"), null);
	assert.equal(reply.querySelector("[onerror]"), null);
	assert.ok(![...reply.querySelectorAll("a")].some(a => (a.getAttribute("href") || "").startsWith("javascript:")));
	assert.equal(chat.window.hacked, undefined);
});

test("the activity line says what omp is doing during a turn, and hides when it ends", () => {
	const start = Date.UTC(2026, 0, 1);
	let now = start;
	const chat = openChat(window => (window.Date.now = () => now));
	const shown = () => (chat.activity.hidden ? null : chat.activity.textContent.replace(/ · \d+s$/, ""));
	const tool = (sessionUpdate, status) => ({
		type: "update",
		update: { sessionUpdate, toolCallId: "t1", title: "Read src/a.ts", kind: "read", status },
	});
	const review = state => ({ type: "review", info: { id: "r1", state, displayPath: "a.ts", hunkCount: 1, summary: "accepted" } });

	assert.equal(shown(), null, "hidden before the first turn");
	chat.deliver({ type: "status", state: "busy" });
	assert.equal(shown(), "Working…");
	chat.deliver({ type: "update", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } });
	assert.equal(shown(), "Thinking…");
	chat.deliver(tool("tool_call", "pending"));
	assert.equal(shown(), "Running: Read src/a.ts");
	chat.deliver(permission);
	assert.equal(shown(), "Waiting for your answer");
	chat.deliver({ type: "resolved", requestId: "7", label: "Allow once" });
	assert.equal(shown(), "Running: Read src/a.ts");
	chat.deliver(tool("tool_call_update", "completed"));
	assert.equal(shown(), "Working…");
	chat.deliver(review("open"));
	assert.equal(shown(), "Waiting for your review");
	now = start + 12_400;
	chat.deliver(review("done"), chunk("All done"));
	assert.equal(chat.activity.textContent, "Writing… · 12s", "with the seconds since the turn began");
	chat.deliver({ type: "status", state: "idle" });
	assert.equal(shown(), null);
});

test("a command rejected from its question card no longer shows as running", () => {
	const chat = openChat();
	const shown = () => chat.activity.textContent.replace(/ · \d+s$/, "");
	chat.deliver({ type: "status", state: "busy" }, { ...permission, toolCallId: "call-1" });
	assert.equal(shown(), "Waiting for your answer");
	[...chat.log.querySelectorAll(".tool-ask button")].find(button => button.textContent === "Reject").click();
	assert.equal(shown(), "Working…", "not 'Running: Run ls' for the rest of the turn");
});

test("Stop shows while omp starts for a sent message, but not while it starts on its own", () => {
	const chat = openChat();
	const stop = chat.window.document.getElementById("stop");
	chat.deliver({ type: "status", state: "starting" });
	assert.equal(stop.hidden, true, "nothing to stop yet");
	chat.deliver({ type: "status", state: "idle" }, { type: "status", state: "busy" }, { type: "status", state: "starting" });
	assert.equal(stop.hidden, false, "the message waits for omp to start");
	chat.deliver({ type: "status", state: "idle" });
	assert.equal(stop.hidden, true);
});

test("streamed chunks leave the activity line alone while its label stays the same", async () => {
	const chat = openChat();
	chat.deliver({ type: "status", state: "busy" }, chunk("a"));
	const changes = [];
	new chat.window.MutationObserver(records => changes.push(...records)).observe(chat.activity, { childList: true, characterData: true, subtree: true });
	chat.deliver(chunk("b"), chunk("c"), chunk("d"));
	await Promise.resolve();
	assert.equal(changes.length, 0);

	const running = { type: "update", update: { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Run tests", status: "in_progress" } };
	chat.deliver(running);
	await Promise.resolve();
	changes.length = 0;
	chat.deliver(running, running, running); // a long tool streaming output
	await Promise.resolve();
	assert.equal(changes.length, 0, "repeated tool updates leave it alone too");
	chat.deliver({ type: "status", state: "idle" });
});

test("a card or review left open by an earlier turn does not stick to the next one", () => {
	const chat = openChat();
	const review = { type: "review", info: { id: "r9", state: "open", displayPath: "a.ts", hunkCount: 1 } };
	chat.deliver({ type: "status", state: "busy" }, permission, review, { type: "status", state: "idle" });
	chat.deliver({ type: "status", state: "busy" });
	assert.match(chat.activity.textContent, /^Working…/);
	chat.deliver({ type: "status", state: "idle" });
});

test("queued messages show above the input, can be removed, and come back into the input", () => {
	const chat = openChat();
	const queue = chat.window.document.getElementById("queue");
	const input = chat.window.document.getElementById("input");
	chat.deliver({ type: "queued", id: "1", text: "also fix the tests" }, { type: "queued", id: "2", text: "and the docs" });
	assert.deepEqual([...queue.querySelectorAll(".queued-text")].map(item => item.textContent), ["also fix the tests", "and the docs"]);
	assert.equal(chat.log.textContent, "", "not in the conversation until sent");

	queue.querySelector("button").click();
	assert.deepEqual(chat.posted.at(-1), { type: "unqueue", id: "1" });
	chat.deliver({ type: "dequeued", ids: ["1"] });
	assert.deepEqual([...queue.querySelectorAll(".queued-text")].map(item => item.textContent), ["and the docs"]);

	input.value = "a draft";
	chat.deliver({ type: "dequeued", ids: ["2"] }, { type: "restoreInput", text: "and the docs" });
	assert.equal(queue.children.length, 0);
	assert.equal(input.value, "and the docs\n\na draft", "put back ahead of what was being typed");
});

/**
 * A chat page whose audio player is a stand-in: play() succeeds, or fails with `refusal`.
 * The page is told the sound is on, as the extension does on load, unless `soundOn` is false,
 * and the sound then finishes loading at once, unless `loads` is false.
 */
function openChatWithAudio(refusal, { soundOn = true, loads = true } = {}) {
	const loaded = [];
	const players = [];
	const plays = [];
	const warnings = [];
	const chat = openChat(window => {
		const { HAVE_NOTHING, HAVE_CURRENT_DATA, HAVE_ENOUGH_DATA } = window.HTMLMediaElement;
		window.Audio = class extends window.EventTarget {
			currentTime = 0;
			readyState = HAVE_NOTHING;
			error = null;
			paused = true;
			constructor(src) {
				super();
				this.src = src;
				loaded.push(src);
				players.push(this);
			}
			pause() {
				this.paused = true;
			}
			removeAttribute(name) {
				if (name === "src") this.src = "";
			}
			load() {}
			finishLoading() {
				this.readyState = HAVE_ENOUGH_DATA;
				this.dispatchEvent(new window.Event("canplay"));
				this.dispatchEvent(new window.Event("canplaythrough"));
			}
			play() {
				this.paused = false;
				plays.push({ src: this.src, from: this.currentTime });
				// Where a finished play leaves it: at the end, and (as the spec says once playback ends) no longer HAVE_ENOUGH_DATA.
				this.currentTime = 0.4;
				this.readyState = HAVE_CURRENT_DATA;
				return refusal ? Promise.reject(refusal) : Promise.resolve();
			}
		};
		window.console.warn = (...args) => warnings.push(args.join(" "));
	});
	if (soundOn) chat.deliver({ type: "sound", on: true });
	if (soundOn && loads) players[0].finishLoading();
	return { chat, loaded, players, plays, warnings };
}

test("the finish sound is loaded once the page hears it is on, and replayed from the start on each chime", () => {
	const { chat, loaded, plays } = openChatWithAudio();
	assert.deepEqual(loaded, [CHIME_SRC], "loaded before any turn ends");
	assert.deepEqual(plays, [], "but not played");
	chat.deliver({ type: "chime" }, { type: "chime" }, { type: "chime" });
	assert.deepEqual(plays, [{ src: CHIME_SRC, from: 0 }, { src: CHIME_SRC, from: 0 }, { src: CHIME_SRC, from: 0 }]);
	assert.equal(loaded.length, 1, "no new load per chime");
});

test("with the sound switched off the page loads no audio; switched on, it loads it once", () => {
	const { chat, loaded, players, plays } = openChatWithAudio(undefined, { soundOn: false });
	chat.deliver({ type: "chime" });
	assert.deepEqual(loaded, [], "nothing fetched while off");
	assert.deepEqual(plays, []);
	chat.deliver({ type: "sound", on: true }, { type: "sound", on: true });
	players[0].finishLoading();
	chat.deliver({ type: "chime" });
	assert.deepEqual(loaded, [CHIME_SRC], "loaded once, however often it is told");
	assert.equal(plays.length, 1);
	chat.deliver({ type: "sound", on: false }, { type: "chime" });
	assert.equal(plays.length, 1, "switched off again: silent");
	chat.deliver({ type: "sound", on: true }, { type: "chime" });
	assert.equal(plays.length, 1, "switched on again: silent until the sound has loaded again");
});

test("a chime before the sound has loaded is dropped, not played once it loads", async () => {
	const { chat, players, plays } = openChatWithAudio(undefined, { loads: false });
	chat.deliver({ type: "chime" });
	players[0].finishLoading();
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(plays, [], "the late chime never played");
	chat.deliver({ type: "chime" });
	assert.equal(plays.length, 1, "the next chime plays");
});

test("a sound that fails to load is reported, and loaded again for the next chime", () => {
	const { chat, loaded, players, plays, warnings } = openChatWithAudio(undefined, { loads: false });
	players[0].error = { code: 4, message: "unsupported format" };
	players[0].dispatchEvent(new chat.window.Event("error"));
	assert.match(warnings[0], /could not load the finish chime/);
	chat.deliver({ type: "chime" });
	assert.deepEqual(plays, [], "this chime is skipped");
	assert.equal(loaded.length, 2, "but it starts a new load");
	players[1].finishLoading();
	chat.deliver({ type: "chime" });
	assert.equal(plays.length, 1, "so the next chime plays");
});

test("a sound that fails after it has loaded is loaded again, without breaking the next chime", () => {
	const { chat, loaded, players, plays } = openChatWithAudio();
	const errors = [];
	chat.window.addEventListener("error", event => errors.push(event.message));
	players[0].dispatchEvent(new chat.window.Event("error")); // e.g. a decode error during a later play
	chat.deliver({ type: "chime" });
	assert.deepEqual(errors, [], "the chime did not throw");
	assert.equal(loaded.length, 2, "it started loading the sound again");
	players[1].finishLoading();
	chat.deliver({ type: "chime" });
	assert.equal(plays.length, 1, "and the next chime plays");
});

test("switching the sound off stops it, and a late error from the dropped sound is not reported", () => {
	const { chat, players, warnings } = openChatWithAudio();
	chat.deliver({ type: "chime" });
	assert.equal(players[0].paused, false, "playing");
	chat.deliver({ type: "sound", on: false });
	assert.equal(players[0].paused, true, "stopped at once");
	assert.equal(players[0].src, "", "and no longer loading");
	players[0].dispatchEvent(new chat.window.Event("error"));
	assert.deepEqual(warnings, []);
});

test("a page with no sound address loads nothing", () => {
	const { chat, loaded, warnings } = openChatWithAudio(undefined, { soundOn: false });
	chat.window.document.body.removeAttribute("data-chime");
	chat.deliver({ type: "sound", on: true }, { type: "chime" });
	assert.deepEqual(loaded, []);
	assert.deepEqual(warnings, []);
});

test("a chime the browser refuses on an unused page is dropped quietly, not played when the user later types", async () => {
	const { chat, plays, warnings } = openChatWithAudio({ name: "NotAllowedError" });
	chat.deliver({ type: "chime" });
	await new Promise(resolve => setImmediate(resolve));
	chat.window.document.dispatchEvent(new chat.window.KeyboardEvent("keydown", { key: "a" }));
	chat.window.document.body.dispatchEvent(new chat.window.MouseEvent("click", { bubbles: true }));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(plays.length, 1, "tried once, never retried after the user interacted");
	assert.deepEqual(warnings, []);
});

test("a chime cut short, e.g. by the page being hidden, is not reported", async () => {
	const { chat, plays, warnings } = openChatWithAudio({ name: "AbortError" });
	chat.deliver({ type: "chime" });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(plays.length, 1);
	assert.deepEqual(warnings, []);
});

test("a chime that fails for another reason is reported, not thrown", async () => {
	const { chat, warnings } = openChatWithAudio(new Error("no audio device"));
	chat.deliver({ type: "chime" });
	await new Promise(resolve => setImmediate(resolve));
	assert.match(warnings[0], /could not play the finish chime/);
});

// ---------- attachments ----------
const { wrapAttachment } = require("../dist/core.js");

const chip = (id, kind, name, extra = {}) => ({ id, kind, name, ...extra });
const chipNames = container => [...container.querySelectorAll(".attachment-name")].map(node => node.textContent);

test("+ asks the extension for the file picker", () => {
	const chat = openChat();
	chat.window.document.getElementById("attach").click();
	assert.deepEqual(chat.posted.at(-1), { type: "pickFiles" });
});

/** jsdom decodes no images and draws no canvas: stand-ins with the sizes a real one would have. */
function drawsImages(window, size = { width: 1600, height: 400 }) {
	window.Image = class {
		naturalWidth = size.width;
		naturalHeight = size.height;
		set src(value) {
			queueMicrotask(() => (size.broken ? this.onerror() : this.onload()));
		}
	};
	window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
	window.HTMLCanvasElement.prototype.toDataURL = function () {
		return `data:image/png;base64,${this.width}x${this.height}`;
	};
}

test("attached files show above the input, can be removed, and go with the message", async () => {
	const chat = openChat(window => drawsImages(window, { broken: true })); // so the image's thumbnail is done with at once
	const doc = chat.window.document;
	const tray = doc.getElementById("attachments");
	assert.equal(tray.hidden, true, "hidden while nothing is attached");
	chat.deliver(
		{ type: "attached", attachment: chip("a1", "text", "parser.ts", { path: "src/parser.ts", note: "Its text is sent (about 120 tokens)." }) },
		{ type: "attached", attachment: chip("a2", "image", "shot.png", { thumbnail: "data:image/png;base64,AAA" }) },
		{ type: "attached", attachment: chip("a3", "path", "huge.log") },
	);
	assert.equal(tray.hidden, false);
	assert.deepEqual(chipNames(tray), ["parser.ts", "shot.png", "huge.log"]);
	assert.equal(tray.querySelector(".attachment").title, "src/parser.ts\nIts text is sent (about 120 tokens).", "the path and how it is sent, on hover");
	assert.equal(tray.querySelector("img").getAttribute("src"), "data:image/png;base64,AAA");

	tray.querySelectorAll(".attachment button")[2].click();
	assert.deepEqual(chat.posted.at(-1), { type: "detach", id: "a3" });
	assert.deepEqual(chipNames(tray), ["parser.ts", "shot.png"]);

	await new Promise(resolve => setImmediate(resolve));
	doc.getElementById("input").value = "why does this fail?";
	doc.getElementById("send").click();
	assert.deepEqual(chat.posted.at(-1), { type: "send", text: "why does this fail?", attachments: ["a1", "a2"] });
	assert.equal(tray.hidden, true, "sent: the input is empty again");
});

test("a message can be only attachments", () => {
	const chat = openChat();
	chat.deliver({ type: "attached", attachment: chip("a1", "image", "shot.png") });
	chat.window.document.getElementById("send").click();
	assert.deepEqual(chat.posted.at(-1), { type: "send", text: "", attachments: ["a1"] });
	chat.window.document.getElementById("send").click();
	assert.equal(chat.posted.filter(message => message.type === "send").length, 1, "nothing to send the second time");
});

test("a sent message shows its attachments; editing it puts back only its text", () => {
	const chat = openChat();
	const input = chat.window.document.getElementById("input");
	chat.deliver({ type: "user", text: "look", attachments: [chip("a1", "text", "a.ts"), chip("a2", "image", "b.png")] });
	const message = chat.log.querySelector(".msg.user");
	assert.equal(message.querySelector(".user-text").textContent, "look");
	assert.deepEqual(chipNames(message), ["a.ts", "b.png"]);
	assert.equal(message.querySelector(".attachment button"), null, "a sent file can't be removed");
	message.querySelector("button.edit").click();
	assert.equal(input.value, "look");
});

test("queued messages list their attachments, and Stop puts them back on the input", () => {
	const chat = openChat();
	const doc = chat.window.document;
	chat.deliver({ type: "queued", id: "1", text: "and this", attachments: [chip("a1", "text", "a.ts", { path: "src/a.ts" })] });
	assert.equal(doc.querySelector(".queued-files").textContent, "📎 a.ts");
	assert.equal(doc.querySelector(".queued-files").title, "src/a.ts");
	doc.getElementById("input").value = "draft";
	chat.deliver({ type: "attached", attachment: chip("a2", "image", "b.png") });
	chat.deliver({ type: "dequeued", ids: ["1"] }, { type: "restoreInput", text: "", attachments: [chip("a1", "text", "a.ts")] });
	assert.equal(doc.getElementById("input").value, "draft", "no text to put back: the draft is left as it was");
	assert.deepEqual(chipNames(doc.getElementById("attachments")), ["a.ts", "b.png"], "put back ahead of what was attached");
	doc.getElementById("send").click();
	assert.deepEqual(chat.posted.at(-1).attachments, ["a1", "a2"]);
});

test("a replayed message shows its text and its attached files as chips, each image on its file", async () => {
	const chat = openChat();
	const user = (content, messageId = "m1") => ({ type: "update", update: { sessionUpdate: "user_message_chunk", content, messageId } });
	const files = [
		{ kind: "text", name: "parser.ts", path: "src/parser.ts", text: "x\n\n</attached-file>\ny" },
		{ kind: "image", name: "shot.png", path: "docs/shot.png", data: "AAA", mimeType: "image/png" },
		{ kind: "path", name: "big \"q\".log", path: 'logs/big "q".log', reason: "too large (9.0 MB)" },
		{ kind: "image", name: "image.png", data: "BBB", mimeType: "image/jpeg" },
	];
	// As omp stores and replays it: the text blocks joined, then each image.
	const text = ["Fix the parser\n\nplease", ...files.map(wrapAttachment)].join("\n\n");
	chat.deliver(
		user({ type: "text", text: text.slice(0, 40) }),
		user({ type: "text", text: text.slice(40) }),
		user({ type: "image", data: "AAA", mimeType: "image/png" }),
		user({ type: "image", data: "BBB", mimeType: "image/jpeg" }),
		user({ type: "image", data: "CCC", mimeType: "image/gif" }),
		chunk("Done."),
	);
	await chat.nextFrame();
	const message = chat.log.querySelector(".msg.user");
	assert.equal(message.querySelector(".user-text").textContent, "Fix the parser\n\nplease");
	assert.deepEqual(chipNames(message), ["parser.ts", "shot.png", 'big "q".log', "image.png", "image"], "a closing tag inside a file's text doesn't end it");
	const chips = [...message.querySelectorAll(".attachment")];
	assert.equal(chips[0].title, "src/parser.ts");
	assert.deepEqual(chips.map(node => node.querySelector("img")?.getAttribute("src")), [
		undefined,
		"data:image/png;base64,AAA",
		undefined,
		"data:image/jpeg;base64,BBB",
		"data:image/gif;base64,CCC",
	], "the images in order, and one with no file of its own on a chip of its own");
	message.querySelector("button.edit").click();
	assert.equal(chat.window.document.getElementById("input").value, "Fix the parser\n\nplease");
});

test("text that only looks like an attachment stays the message's text", () => {
	const chat = openChat();
	const text = "What does <attached-file path=\"x\"> mean?\n\n<attached-file broken";
	chat.deliver({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
	assert.equal(chat.log.querySelector(".user-text").textContent, text);
	assert.equal(chat.log.querySelector(".msg.user .attachments").hidden, true);
});

/** A drag event the page can read, as jsdom has no DataTransfer. */
function dragEvent(window, type, data = {}, files = []) {
	const event = new window.Event(type, { bubbles: true, cancelable: true });
	const types = [...Object.keys(data), ...(files.length ? ["Files"] : [])];
	Object.defineProperty(event, "dataTransfer", { value: { types, files, getData: key => data[key.toLowerCase()] ?? "", dropEffect: "none" } });
	return event;
}

test("files dropped from the Explorer go to the extension by address; the drop target lights up while dragging", () => {
	const chat = openChat();
	const { window } = chat;
	const body = window.document.body;
	body.dispatchEvent(dragEvent(window, "dragenter", { "text/uri-list": "" }));
	assert.ok(body.classList.contains("dropping"));
	const over = dragEvent(window, "dragover", { "text/uri-list": "" });
	body.dispatchEvent(over);
	assert.ok(over.defaultPrevented, "the page accepts the drop");
	const drop = dragEvent(window, "drop", { "application/vnd.code.uri-list": "file:///repo/a.ts\r\n# a comment\r\nfile:///repo/b%20c.ts\r\n" });
	body.dispatchEvent(drop);
	assert.ok(drop.defaultPrevented);
	assert.equal(body.classList.contains("dropping"), false);
	assert.deepEqual(chat.posted.at(-1), { type: "attachUris", uris: ["file:///repo/a.ts", "file:///repo/b%20c.ts"] });

	body.dispatchEvent(dragEvent(window, "drop", { codefiles: JSON.stringify(["/repo/c.ts"]) }));
	assert.deepEqual(chat.posted.at(-1), { type: "attachUris", uris: ["/repo/c.ts"] }, "VS Code's own list of paths");
});

test("dragged text is left to drop into the input", () => {
	const chat = openChat();
	const drop = dragEvent(chat.window, "drop", { "text/plain": "hello" });
	chat.window.document.body.dispatchEvent(drop);
	assert.equal(drop.defaultPrevented, false);
	assert.deepEqual(chat.posted.filter(message => message.type.startsWith("attach")), []);
});

/** Wait for the page's FileReader to post what it read. */
async function postedAttachData(chat, count = 1) {
	for (let i = 0; i < 100 && chat.posted.filter(message => message.type === "attachData").length < count; i++) await new Promise(resolve => setTimeout(resolve, 5));
	return chat.posted.filter(message => message.type === "attachData");
}

test("files dropped from outside VS Code, and pasted images, are read by the page and handed over", async () => {
	const chat = openChat();
	const { window } = chat;
	const file = new window.File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
	window.document.body.dispatchEvent(dragEvent(window, "drop", {}, [file]));
	assert.deepEqual(await postedAttachData(chat), [{ type: "attachData", name: "shot.png", data: "iVBORw==" }]);

	const input = window.document.getElementById("input");
	const paste = new window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File(["hi"], "image.png", { type: "image/png" })] } });
	input.dispatchEvent(paste);
	assert.ok(paste.defaultPrevented);
	assert.deepEqual((await postedAttachData(chat, 2))[1], { type: "attachData", name: "image.png", data: "aGk=" });

	const textPaste = new window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(textPaste, "clipboardData", { value: { files: [] } });
	input.dispatchEvent(textPaste);
	assert.equal(textPaste.defaultPrevented, false, "a text paste is left alone");
});

/** A paste event the page can read, as jsdom has no DataTransfer. */
function pasteEvent(window, data, files) {
	const event = new window.Event("paste", { bubbles: true, cancelable: true });
	const types = [...Object.keys(data), ...(files.length ? ["Files"] : [])];
	Object.defineProperty(event, "clipboardData", { value: { types, files, getData: type => data[type] ?? "" } });
	return event;
}

test("cells copied from Excel paste as their text, not as the picture of them that comes along", async () => {
	const chat = openChat();
	const { window } = chat;
	const input = window.document.getElementById("input");
	const picture = () => [new window.File(["png"], "image.png", { type: "image/png" })];
	const excel = pasteEvent(window, { "text/plain": "Hours\t8\nDays\t5", "text/html": "<table>…</table>" }, picture());
	input.dispatchEvent(excel);
	assert.equal(excel.defaultPrevented, false, "the text pastes as usual");
	const keynote = pasteEvent(window, { "text/plain": "Slide title", "text/rtf": "{\\rtf1 Slide title}" }, picture());
	input.dispatchEvent(keynote);
	assert.equal(keynote.defaultPrevented, false);

	const finder = pasteEvent(window, { "text/plain": "report.pdf" }, [new window.File(["%PDF"], "report.pdf")]);
	input.dispatchEvent(finder);
	assert.ok(finder.defaultPrevented, "a file copied in Finder comes with only its name: it is attached");
	const copiedImage = pasteEvent(window, { "text/html": '<img src="https://example.com/a.png">' }, picture());
	input.dispatchEvent(copiedImage);
	assert.ok(copiedImage.defaultPrevented, "an image copied from a web page has no plain text: it is attached");
	assert.deepEqual((await postedAttachData(chat, 2)).map(message => message.name), ["report.pdf", "image.png"]);
});

test("a slash command can't be sent with attached files; the command and the files stay in the input", () => {
	const chat = openChat();
	const doc = chat.window.document;
	const input = doc.getElementById("input");
	chat.deliver({ type: "attached", attachment: chip("a1", "text", "notes.md") });
	input.value = "/compact";
	doc.getElementById("send").click();
	assert.equal(chat.posted.filter(message => message.type === "send").length, 0);
	assert.match(chat.log.querySelector(".notice.warning").textContent, /slash command can't take attached files/);
	assert.equal(input.value, "/compact");
	assert.deepEqual(chipNames(doc.getElementById("attachments")), ["notes.md"]);

	input.value = "/Users/me/notes.md is the file";
	doc.getElementById("send").click();
	assert.equal(chat.posted.at(-1).type, "send", "a path is no command");

	chat.deliver(
		{ type: "update", update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact" }] } },
		{ type: "attached", attachment: chip("a2", "text", "notes.md") },
	);
	input.value = "/tmp is full, why?";
	doc.getElementById("send").click();
	assert.deepEqual(chat.posted.at(-1), { type: "send", text: "/tmp is full, why?", attachments: ["a2"] }, "once omp has listed its commands, only those count");
});

test("an attached image's chip gets a small thumbnail, which the extension keeps for the sent message", async () => {
	const chat = openChat(window => drawsImages(window));
	chat.deliver({ type: "attached", attachment: chip("a1", "image", "shot.png", { thumbnail: "data:image/png;base64,WHOLE" }) });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(chat.posted.at(-1), { type: "thumbnail", id: "a1", data: "data:image/png;base64,112x28" }, "no wider than twice the chip's 56 px");
	assert.equal(chat.window.document.querySelector("#attachments img").getAttribute("src"), "data:image/png;base64,112x28");
});

test("a message sent right after an image is attached waits for its thumbnail, so the sent chip shows it", async () => {
	const chat = openChat(window => drawsImages(window));
	const doc = chat.window.document;
	chat.deliver({ type: "attached", attachment: chip("a1", "image", "shot.png", { thumbnail: "data:image/png;base64,WHOLE" }) });
	doc.getElementById("input").value = "what is this?";
	doc.getElementById("send").click();
	assert.equal(doc.getElementById("input").value, "", "the input empties at once");
	doc.getElementById("input").value = "and this";
	doc.getElementById("send").click(); // nothing of its own to wait for, but sent after the first
	assert.deepEqual(chat.posted.filter(message => message.type === "send"), [], "not sent before the thumbnail");
	await new Promise(resolve => setImmediate(resolve));
	const sent = chat.posted.filter(message => message.type === "thumbnail" || message.type === "send");
	assert.deepEqual(sent.map(message => message.text ?? message.type), ["thumbnail", "what is this?", "and this"]);
});

test("Stop pressed while a message waits for its thumbnail reaches the extension after it, so the message goes back to the input", async () => {
	const chat = openChat(window => drawsImages(window));
	const doc = chat.window.document;
	chat.deliver({ type: "attached", attachment: chip("a1", "image", "shot.png", { thumbnail: "data:image/png;base64,WHOLE" }) });
	doc.getElementById("input").value = "what is this?";
	doc.getElementById("send").click();
	doc.getElementById("stop").click();
	assert.deepEqual(chat.posted.filter(message => message.type === "cancel"), [], "held behind the message");
	await new Promise(resolve => setImmediate(resolve));
	const order = chat.posted.filter(message => ["thumbnail", "send", "cancel"].includes(message.type)).map(message => message.type);
	assert.deepEqual(order, ["thumbnail", "send", "cancel"]);

	doc.getElementById("stop").click();
	assert.equal(chat.posted.at(-1).type, "cancel", "with nothing waiting, Stop goes at once");
});

test("a file too large for the page to read is not read, and the user is told how to attach it", () => {
	const chat = openChat();
	const { window } = chat;
	const huge = { name: "video.mov", size: 21 * 1024 * 1024 };
	window.document.body.dispatchEvent(dragEvent(window, "drop", {}, [huge]));
	assert.match(chat.log.querySelector(".notice.warning").textContent, /video\.mov is too large to attach from here .*attach it with \+/);
	assert.deepEqual(chat.posted.filter(message => message.type === "attachData"), []);
});

test("omp's description of an image, replayed for a model that can't read images, is a note and not a message of the user's", async () => {
	const chat = openChat();
	const user = (content, messageId) => ({ type: "update", update: { sessionUpdate: "user_message_chunk", content, messageId } });
	// As omp 18.6.1 replayed a chat whose model reads no images.
	chat.deliver(
		user({ type: "text", text: '<image path="local://image-45b8.webp">\nA solid red rectangle occupies the entire frame.\n</image>' }, "d1"),
		user({ type: "text", text: 'What colour?\n\n<attached-file path="swatch.png" type="image">\nThe image is attached to this message.\n</attached-file>' }, "m1"),
		user({ type: "image", data: "UklGRg==", mimeType: "image/webp" }, "m1"),
	);
	const note = chat.log.querySelector(".image-description");
	assert.match(note.querySelector("summary").textContent, /described the image for the model/);
	assert.equal(note.querySelector("div").textContent, "A solid red rectangle occupies the entire frame.");
	const messages = chat.log.querySelectorAll(".msg.user");
	assert.equal(messages.length, 1, "only the user's own message is a message");
	assert.equal(messages[0].querySelector(".user-text").textContent, "What colour?");
	assert.equal(messages[0].querySelector("img").getAttribute("src"), "data:image/webp;base64,UklGRg==");
});

test("an empty attached file and one ending in a newline both replay as chips", () => {
	const chat = openChat();
	const text = ['<attached-file path="empty.txt">\n</attached-file>', '<attached-file path="a.txt">\none\n</attached-file>'].join("\n\n");
	chat.deliver({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
	assert.deepEqual(chipNames(chat.log.querySelector(".msg.user")), ["empty.txt", "a.txt"]);
	assert.equal(chat.log.querySelector(".user-text").textContent, "");
});

test("a replayed document attachment shows as a document chip", () => {
	const chat = openChat();
	const text = `Summarise it\n\n${wrapAttachment({ id: "1", kind: "document", name: "plan.docx", path: "/tmp/x/a1/plan.docx", reason: "a Word document" })}`;
	chat.deliver({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });
	const chip = chat.log.querySelector(".msg.user .attachment");
	assert.ok(chip.classList.contains("attachment-document"));
	assert.equal(chip.querySelector(".attachment-icon").textContent, "📑");
	assert.equal(chip.querySelector(".attachment-name").textContent, "plan.docx");
	assert.equal(chat.log.querySelector(".user-text").textContent, "Summarise it");
});
