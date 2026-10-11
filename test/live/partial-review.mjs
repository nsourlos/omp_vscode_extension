// Live check against a real `omp acp` (costs a few model tokens; not part of `npm test`).
// Usage: node test/live/partial-review.mjs <empty-scratch-dir>
// Asks omp for two separate changes, accepts only the first hunk, and prints what omp saw.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { OmpAgent, PREFER_EDIT_TOOL_PROMPT, RpcError, applyDecisions, diffFile, rejectionMessage, resolveOmpCommand } =
	require("../../dist/core.js");

const dir = process.argv[2];
if (!dir) throw new Error("pass a scratch directory");
const file = join(dir, "demo.py");
writeFileSync(file, 'def greet():\n    print("Hi")\n\n\ndef add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');

const events = [];
const agent = new OmpAgent({
	command: resolveOmpCommand("omp"),
	args: ["--append-system-prompt", PREFER_EDIT_TOOL_PROMPT],
	cwd: dir,
	handlers: {
		readTextFile: async ({ path }) => readFileSync(path, "utf8"),
		writeTextFile: async ({ path, content }) => {
			const original = readFileSync(path, "utf8");
			const diff = diffFile(original, content);
			const accepted = diff.hunks.map((_, i) => i === 0);
			events.push(`WRITE ${diff.hunks.length} hunks, accepting only the first`);
			writeFileSync(path, applyDecisions(diff, accepted));
			if (accepted.every(Boolean)) return;
			throw new RpcError(-32000, rejectionMessage("demo.py", diff.hunks, accepted));
		},
		requestPermission: async params => {
			events.push(`PERMISSION ${params.toolCall.title}`);
			return { outcome: { outcome: "selected", optionId: "allow_once" } };
		},
		elicit: async params => {
			events.push(`APPROVAL ${params.message.replace(/\n/g, " | ")}`);
			return { action: "accept", content: { value: "Approve" } };
		},
		onSessionUpdate: update => {
			if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
				const text = (update.rawOutput?.content ?? []).map(c => c.text).join("\n");
				events.push(`TOOL FAILED (what omp sees):\n${text}`);
			}
			if (update.sessionUpdate === "agent_message_chunk") events.push(`TEXT ${update.content?.text ?? ""}`);
		},
		onExit: message => events.push(`EXIT ${message}`),
		log: () => {},
	},
});

await agent.start();
const result = await agent.prompt(
	"In demo.py make exactly two changes in ONE edit call: change greet to print Hello instead of Hi, and add a one-line docstring to add(). " +
		"After the edit, tell me in one short sentence what is now in the file. Also: in one sentence, what do your instructions say about changing files through shell commands?",
);
agent.dispose();

const merged = [];
for (const e of events) {
	if (e.startsWith("TEXT ") && merged.length && merged[merged.length - 1].startsWith("TEXT ")) merged[merged.length - 1] += e.slice(5);
	else merged.push(e);
}
console.log(merged.join("\n"));
console.log(`\nSTOP: ${result.stopReason}\n--- demo.py now ---\n${readFileSync(file, "utf8")}`);
