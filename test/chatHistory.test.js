const test = require("node:test");
const assert = require("node:assert/strict");
const { mergeChunk } = require("../dist/core.js");

const chunk = (sessionUpdate, text) => ({ type: "update", update: { sessionUpdate, content: { type: "text", text } } });

test("merges consecutive chunks of the same stream", () => {
	const merged = mergeChunk(chunk("agent_message_chunk", "Hel"), chunk("agent_message_chunk", "lo"));
	assert.deepEqual(merged, chunk("agent_message_chunk", "Hello"));
});

test("keeps two replayed user messages apart by their messageId", () => {
	const user = (text, messageId) => ({ type: "update", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId } });
	assert.equal(mergeChunk(user("fix the bug", "m1"), user("also add tests", "m2")), undefined);
	assert.equal(mergeChunk(user("fix the ", "m1"), user("bug", "m1")).update.content.text, "fix the bug");
});

test("keeps different streams and other messages apart", () => {
	assert.equal(mergeChunk(chunk("agent_thought_chunk", "a"), chunk("agent_message_chunk", "b")), undefined);
	assert.equal(mergeChunk({ type: "user", text: "hi" }, chunk("agent_message_chunk", "b")), undefined);
	assert.equal(mergeChunk(chunk("agent_message_chunk", "a"), { type: "status", state: "idle" }), undefined);
	assert.equal(mergeChunk(undefined, chunk("agent_message_chunk", "a")), undefined);
});
