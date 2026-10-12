// The chat page (media/chat.js) in a simulated browser: what it shows, and what it sends back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const script = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");

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
	const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
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

test("a browser approval names the page and shows the code behind a toggle", () => {
	const chat = openChat();
	const code = 'await tab.goto("https://example.com/a")';
	chat.deliver({ type: "approval", requestId: "9", toolName: "browser", details: "", code, urls: ["https://example.com/a"] });
	const card = chat.log.querySelector(".card");
	assert.equal(card.querySelector(".card-heading").textContent, "Allow omp to use the browser?");
	assert.equal(card.querySelector(".location").textContent, "🌐 https://example.com/a");
	assert.equal(card.querySelector("details pre").textContent, code);
	assert.equal(card.querySelector("details").open, false, "the code starts folded");

	chat.deliver({ type: "approval", requestId: "10", toolName: "browser", details: "" });
	assert.equal(chat.log.querySelectorAll(".card")[1].querySelector(".field-description").textContent, "omp did not say which page.");

	chat.deliver({ type: "approval", requestId: "11", toolName: "browser", details: "", unclear: true });
	assert.match(chat.log.querySelectorAll(".card")[2].querySelector(".field-description").textContent, /unclear which page/);
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

/** A chat page with a stand-in audio device whose permission to play, and clock, the test controls. */
function openChatWithAudio() {
	const audio = { devices: [], tones: [], last: null, now: 0 };
	class FakeAudioContext {
		state = "suspended";
		currentTime = 0;
		destination = {};
		constructor() {
			audio.devices.push(this);
		}
		waiting = [];
		/** Like Chrome: once audio may start, every resume() still waiting resolves together. */
		allow() {
			this.state = "running";
			for (const resolve of this.waiting.splice(0)) resolve();
		}
		resume() {
			return new Promise(resolve => this.waiting.push(resolve));
		}
		suspend() {
			this.state = "suspended";
			return Promise.resolve();
		}
		createOscillator() {
			const tone = { frequency: {}, connect: node => node, start: () => audio.tones.push(tone.frequency.value), stop() {} };
			audio.last = tone;
			return tone;
		}
		createGain() {
			return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: node => node };
		}
	}
	const chat = openChat(window => {
		window.AudioContext = FakeAudioContext;
		window.Date.now = () => audio.now;
	});
	return { chat, audio };
}

test("audio starts only for a chime, plays two tones, then pauses", async () => {
	const { chat, audio } = openChatWithAudio();
	chat.window.document.dispatchEvent(new chat.window.KeyboardEvent("keydown", { key: "a" }));
	assert.equal(audio.devices.length, 0, "typing alone starts no audio");

	chat.deliver({ type: "chime" });
	audio.devices[0].allow();
	await Promise.resolve();
	assert.deepEqual(audio.tones, [880, 1318.5]);
	audio.last.onended();
	assert.equal(audio.devices[0].state, "suspended", "audio pauses once the tones end");
});

test("a chime that may only play after a later key press is dropped, not played late", async () => {
	const { chat, audio } = openChatWithAudio();
	chat.deliver({ type: "chime" });
	audio.now = 5000; // the user comes back and presses a key
	audio.devices[0].allow();
	await Promise.resolve();
	assert.deepEqual(audio.tones, []);
	assert.equal(audio.devices[0].state, "suspended", "and audio is paused again");
});

test("a dropped chime does not silence the next one when both get audio at once", async () => {
	const { chat, audio } = openChatWithAudio();
	chat.deliver({ type: "chime" }); // before the user has touched the page: it waits
	audio.now = 5000;
	chat.deliver({ type: "chime" }); // after the user typed a message
	audio.devices[0].allow();
	await Promise.resolve();
	assert.deepEqual(audio.tones, [880, 1318.5]);
	assert.equal(audio.devices[0].state, "running", "the late first chime did not pause the second one's audio");
});

test("a chime whose audio cannot start is reported, not thrown", async () => {
	const { chat } = openChatWithAudio();
	const warnings = [];
	chat.window.AudioContext.prototype.resume = () => Promise.reject(new Error("no audio device"));
	chat.window.console.warn = (...args) => warnings.push(args.join(" "));
	chat.deliver({ type: "chime" });
	await new Promise(resolve => setImmediate(resolve));
	assert.match(warnings[0], /could not play the finish chime/);
});
