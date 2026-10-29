const test = require("node:test");
const assert = require("node:assert/strict");
const { newTabState, readTabState, tabStateAfter, unsentFiles, unsentText } = require("../dist/core.js");

test("a tab's state follows what is posted to its page: sent, running, queued", () => {
	let state = newTabState("OMP 3");
	assert.equal(state.saved, false, "a new tab has no chat for omp to load");
	for (const message of [
		{ type: "user", text: "hi" },
		{ type: "status", state: "busy" },
		{ type: "queued", id: "1", text: "then this" },
		{ type: "queued", id: "2", text: "and this", attachments: [{ id: "a1", name: "shot.png", kind: "image" }] },
		{ type: "dequeued", ids: ["1"] },
	]) {
		state = tabStateAfter(state, message);
	}
	assert.deepEqual(state, { label: "OMP 3", sessionId: undefined, title: undefined, saved: true, busy: true, queued: [{ id: "2", text: "and this", files: ["shot.png"] }] });
	state = tabStateAfter(state, { type: "status", state: "idle" });
	assert.equal(state.busy, false);
	assert.equal(newTabState("OMP 1", "saved-1").saved, true, "a saved chat opened in a tab can be loaded again");
});

test("a message that changes nothing keeps the same state, so the page isn't sent it again", () => {
	const state = tabStateAfter(newTabState("OMP 1"), { type: "user", text: "hi" });
	assert.equal(tabStateAfter(state, { type: "user", text: "again" }), state);
	assert.equal(tabStateAfter(state, { type: "update", update: {} }), state);
	assert.equal(tabStateAfter(state, { type: "status", state: "idle" }), state);
	assert.equal(tabStateAfter(state, { type: "dequeued", ids: ["9"] }), state);
});

test("a state handed back by VS Code is checked, since it comes from the page", () => {
	assert.equal(readTabState(undefined), undefined);
	assert.equal(readTabState({ sessionId: "x" }), undefined, "no name: not one of ours");
	assert.deepEqual(readTabState({ label: "OMP 2", sessionId: "s", saved: "yes", busy: true, queued: [{ id: 1, text: "a", files: ["x.md", 3] }, { text: 5 }, null], input: "", inputFiles: "no" }), {
		label: "OMP 2",
		sessionId: "s",
		title: undefined,
		saved: false,
		busy: true,
		queued: [{ id: "1", text: "a", files: ["x.md"] }],
		input: undefined,
		inputFiles: [],
	});
});

test("a restored tab's input gets the queued messages, then what was being typed; their files are named", () => {
	const state = {
		label: "OMP 1",
		saved: true,
		busy: false,
		queued: [{ id: "1", text: "first", files: ["a.md"] }, { id: "2", text: " ", files: ["shot.png"] }],
		input: "typing",
		inputFiles: ["b.txt"],
	};
	assert.equal(unsentText(state), "first\n\ntyping");
	assert.deepEqual(unsentFiles(state), ["a.md", "shot.png", "b.txt"], "a queued message of only a file is named too");
	assert.equal(unsentText({ ...state, queued: [], input: undefined }), "");
});
