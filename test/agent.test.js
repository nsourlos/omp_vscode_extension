const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { OmpAgent } = require("../dist/core.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a reply to an omp that stopped reading raises no uncaught error", async () => {
	let release;
	const agent = new OmpAgent({
		command: join(__dirname, "fixtures", "fake-omp.mjs"),
		args: [],
		cwd: mkdtempSync(join(tmpdir(), "omp-agent-test-")),
		handlers: {
			readTextFile: async () => "",
			writeTextFile: () => new Promise(resolve => (release = resolve)),
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			elicit: async () => ({ action: "cancel" }),
			onSessionUpdate: () => {},
			onExit: () => {},
			log: () => {},
		},
	});
	const errors = [];
	const collect = error => errors.push(error);
	process.on("uncaughtException", collect);
	try {
		await agent.start();
		void agent.prompt(JSON.stringify([{ closeStdin: true }, { write: { path: "x.txt", content: "y" } }])).catch(() => {});
		while (!release) await sleep(10);
		release();
		await sleep(300);
	} finally {
		agent.dispose();
		process.off("uncaughtException", collect);
	}
	assert.deepEqual(errors.map(error => error.code), []);
});
