// The chat page (media/chat.js) in a simulated browser: what it shows, and what it sends back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const script = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");

const CHIME_SRC = "media/staplebops-01.mp3";

/** The page's markup, as built by chatHtml() in src/chatPanel.ts. */
const BODY = `<div id="log"></div>
<div id="activity" hidden></div>
<div id="queue"></div>
<footer>
  <div id="settings"></div>
  <textarea id="input"></textarea>
  <div class="row"><span id="status"></span><span id="usage"></span><button id="stop" hidden></button><button id="send"></button></div>
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

test("clicking a card sends the answer with its label and locks the card", () => {
	const chat = openChat();
	chat.deliver(permission);
	const card = chat.log.querySelector(".card");
	card.querySelector("button").click();
	assert.deepEqual(chat.posted.at(-1), { type: "respond", requestId: "7", value: "allow_once", label: "Allow once" });
	assert.ok(card.classList.contains("resolved"));
	assert.ok([...card.querySelectorAll("button")].every(button => button.disabled));
	assert.equal(card.querySelector(".card-result").textContent, "Allow once");
});

test("an answered card stays answered when the chat is replayed", () => {
	const chat = openChat();
	chat.deliver(permission, { type: "resolved", requestId: "7", label: "Allow once" });
	const card = chat.log.querySelector(".card");
	assert.ok(card.classList.contains("resolved"));
	assert.ok([...card.querySelectorAll("button")].every(button => button.disabled));
	assert.equal(card.querySelector(".card-result").textContent, "Allow once");
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
	assert.equal(reply[0].textContent, words.join(""));
});

test("a reply cut by a tool call is rendered in full before the next one starts", async () => {
	const chat = openChat();
	chat.deliver(chunk("Hello "), chunk("there"));
	chat.deliver({ type: "update", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a file", kind: "read" } });
	chat.deliver(chunk("Done"));
	const replies = chat.log.querySelectorAll(".msg.assistant");
	assert.equal(replies[0].textContent, "Hello there", "the first reply rendered as soon as the second began");
	await chat.nextFrame();
	assert.deepEqual([...replies].map(reply => reply.textContent), ["Hello there", "Done"]);
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

/** A chat page whose audio player is a stand-in: play() succeeds, or fails with `refusal`. */
function openChatWithAudio(refusal) {
	const loaded = [];
	const plays = [];
	const warnings = [];
	const chat = openChat(window => {
		window.Audio = class {
			currentTime = 0;
			constructor(src) {
				this.src = src;
				loaded.push(src);
			}
			play() {
				plays.push({ src: this.src, from: this.currentTime });
				this.currentTime = 0.4; // where a finished play leaves it
				return refusal ? Promise.reject(refusal) : Promise.resolve();
			}
		};
		window.console.warn = (...args) => warnings.push(args.join(" "));
	});
	return { chat, loaded, plays, warnings };
}

test("the finish sound is loaded once with the page and replayed from the start on each chime", () => {
	const { chat, loaded, plays } = openChatWithAudio();
	assert.deepEqual(loaded, [CHIME_SRC], "loaded before any turn ends");
	assert.deepEqual(plays, [], "but not played");
	chat.deliver({ type: "chime" }, { type: "chime" });
	assert.deepEqual(plays, [{ src: CHIME_SRC, from: 0 }, { src: CHIME_SRC, from: 0 }]);
	assert.equal(loaded.length, 1, "no new load per chime");
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

test("a chime that fails for another reason is reported, not thrown", async () => {
	const { chat, warnings } = openChatWithAudio(new Error("no audio device"));
	chat.deliver({ type: "chime" });
	await new Promise(resolve => setImmediate(resolve));
	assert.match(warnings[0], /could not play the finish chime/);
});
