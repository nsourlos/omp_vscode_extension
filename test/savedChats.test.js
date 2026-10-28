const test = require("node:test");
const assert = require("node:assert/strict");
const { chatsToShow, continuedIn, forgetDeleted, otherFolderChats } = require("../dist/core.js");

const chat = (sessionId, cwd, updatedAt, messageCount = 2) => ({ sessionId, cwd, title: sessionId, updatedAt, _meta: { messageCount } });

test("the chats to show are newest first, each once, without empty ones", () => {
	const chats = [chat("old", "/a", "2026-01-01"), chat("empty", "/a", "2026-03-01", 0), chat("new", "/b", "2026-02-01"), chat("old", "/a", "2026-01-01")];
	assert.deepEqual(chatsToShow(chats).map(c => c.sessionId), ["new", "old"]);
});

test("the chats continued in a folder", () => {
	const continued = {
		one: { folder: "/new-name" },
		two: { folder: "/new-name" },
		three: { folder: "/elsewhere" },
	};
	assert.deepEqual([...continuedIn(continued, "/new-name")], ["one", "two"]);
	assert.equal(continuedIn(continued, "/unknown").size, 0);
});

test("other folders' chats leave out the shown ones and put chats from folders that are gone first", () => {
	const all = [
		chat("here", "/project", "2026-04-01"),
		chat("gone", "/old-name", "2026-02-01"),
		chat("other", "/another", "2026-03-01"),
		chat("empty", "/old-name", "2026-05-01", 0),
	];
	const { moved, other } = otherFolderChats(all, new Set(["here"]), path => path !== "/old-name");
	assert.deepEqual(moved.map(c => c.sessionId), ["gone"]);
	assert.deepEqual(other.map(c => c.sessionId), ["other"]);
});

test("a continued chat omp no longer has is forgotten", () => {
	const continued = {
		kept: { folder: "/new-name" },
		deleted: { folder: "/new-name" },
	};
	assert.deepEqual(Object.keys(forgetDeleted(continued, [chat("kept", "/old-name", "2026-01-01")])), ["kept"]);
});
