// The chat page (media/chat.js) in a simulated browser: what it shows, and what it sends back.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const script = fs.readFileSync(path.join(__dirname, "..", "media", "chat.js"), "utf8");

/** The page's markup, as built by chatHtml() in src/chatPanel.ts. */
const BODY = `<div id="log"></div>
<footer>
  <div id="settings"></div>
  <textarea id="input"></textarea>
  <div class="row"><span id="status"></span><span id="usage"></span><button id="stop" hidden></button><button id="send"></button></div>
</footer>`;

function openChat() {
	const dom = new JSDOM(`<!DOCTYPE html><body>${BODY}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
	const { window } = dom;
	const posted = [];
	// Copied like the real VS Code bridge does, which also turns them into plain Node objects.
	window.acquireVsCodeApi = () => ({ postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) });
	window.Element.prototype.scrollIntoView = () => {};
	window.eval(script);
	return {
		posted,
		log: window.document.getElementById("log"),
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
