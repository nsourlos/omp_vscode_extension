const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BackgroundWatch, SessionFileReader, SessionTracker, findSessionFile, ownTurnJobs, ownTurnStopReason, ownTurnUpdates } = require("../dist/core.js");

// Entries as omp writes them to a chat's file (~/.omp/agent/sessions/<folder>/<time>_<id>.jsonl).
let nextEntry = 1;
const entry = (fields, at = new Date()) => ({ id: `e${nextEntry++}`, timestamp: at.toISOString(), ...fields });
const user = text => entry({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const reply = (content, stopReason = "stop") => entry({ type: "message", message: { role: "assistant", content, stopReason } });
const bashCall = (id, command) => reply([{ type: "toolCall", id, name: "bash", arguments: { command } }], "toolUse");
const result = (toolCallId, toolName, text, details) => entry({ type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details } });
const backgrounded = (toolCallId, jobId) => result(toolCallId, "bash", `Moved to the background as ${jobId}`, { async: { state: "running", jobId, type: "bash" } });
const jobResult = (jobId, label) =>
	entry({ type: "custom_message", customType: "async-result", content: `<system-notice>\nBackground job ${jobId} has completed.`, details: { jobs: [{ jobId, type: "bash", label }] } });

test("a command moved to the background is a running job until its result comes back; omp's turn after it is its own", () => {
	const tracker = new SessionTracker();
	assert.deepEqual(tracker.apply([user("run the eval"), bashCall("c1", "python eval.py"), backgrounded("c1", "bg_1"), reply([{ type: "text", text: "Started it." }])]), []);
	assert.equal(tracker.continuing, false, "a turn asked for is not omp's own");
	assert.deepEqual([...tracker.jobs.values()].map(({ id, kind, label }) => ({ id, kind, label })), [{ id: "bg_1", kind: "command", label: "python eval.py" }]);
	// omp carries on in the same turn (reminded of its to-do list): still the turn asked for.
	assert.deepEqual(tracker.apply([entry({ type: "custom_message", customType: "mid-run-todo-nudge", content: "todos left" }), reply([{ type: "text", text: "And the rest." }])]), []);
	tracker.askedTurnEnded();
	assert.equal(tracker.continuing, false, "the turn asked for has ended");

	const own = [jobResult("bg_1", "python eval.py"), reply([{ type: "text", text: "The eval passed." }])];
	assert.deepEqual(tracker.apply(own.slice(0, 1)), []);
	assert.equal(tracker.jobs.size, 0, "reported back");
	assert.equal(tracker.continuing, true, "omp carries on by itself");
	assert.deepEqual(tracker.apply(own.slice(1)), [own], "its turn, once it ends");
	assert.equal(tracker.continuing, false);
});

test("a job's result that comes during a turn asked for is part of it, and jobs end in other ways too", () => {
	const tracker = new SessionTracker();
	tracker.apply([user("go"), bashCall("c1", "sleep 90"), backgrounded("c1", "bg_1"), bashCall("c2", "sleep 95"), backgrounded("c2", "bg_2")]);
	assert.deepEqual([...tracker.jobs.keys()], ["bg_1", "bg_2"]);
	// Waited for in the turn (omp's wait tool), and reported back while the turn still runs.
	const waited = result("c3", "wait", "## Completed (1)", { op: "wait", jobs: [{ id: "bg_1", status: "completed" }, { id: "bg_2", status: "running" }] });
	assert.deepEqual(tracker.apply([waited, jobResult("bg_2", "sleep 95"), reply([{ type: "text", text: "Both done." }])]), [], "no turn of omp's own");
	assert.equal(tracker.jobs.size, 0);
	tracker.askedTurnEnded();

	// Helper agents started in the background.
	tracker.apply([user("scout"), result("c4", "task", "Spawned 2 background agents using scout.\n- `ScoutA` (job `ScoutA`)\n- `ScoutB` (job `ScoutB`)", {}), reply([{ type: "text", text: "Spawned." }])]);
	assert.deepEqual([...tracker.jobs.values()].map(job => `${job.kind} ${job.label}`), ["agent ScoutA", "agent ScoutB"]);
	tracker.apply([entry({ type: "custom", customType: "session_exit" })]);
	assert.equal(tracker.jobs.size, 0, "omp exited: its jobs went with it");
});

test("a stopped turn's last reply, written after it ended, is not taken for a turn of omp's own", () => {
	const tracker = new SessionTracker();
	tracker.apply([user("go"), bashCall("c1", "make")]);
	tracker.askedTurnEnded(); // stopped: the file says so only later
	assert.deepEqual(tracker.apply([reply([{ type: "text", text: "partial" }], "aborted")]), []);
	assert.equal(tracker.continuing, false);
});

test("a turn omp ran by itself is shown as omp replays a saved chat", () => {
	const turn = [
		jobResult("bg_1", "python eval.py"),
		reply([{ type: "thinking", thinking: "Check the report." }, { type: "text", text: "Reading the report." }, { type: "toolCall", id: "c9", name: "bash", arguments: '{"command":"cat report.md"}' }], "toolUse"),
		result("c9", "bash", "all 12 passed"),
		reply([{ type: "toolCall", id: "c10", name: "read", arguments: { path: "notes.md" }, intent: "Reading the notes" }], "toolUse"),
		entry({ type: "message", message: { role: "toolResult", toolCallId: "c10", toolName: "read", content: [{ type: "text", text: "no such file" }], isError: true } }),
		reply([{ type: "text", text: "The eval passed." }], "length"),
	];
	assert.deepEqual(ownTurnUpdates(turn), [
		{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Check the report." } },
		{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the report." } },
		{ sessionUpdate: "tool_call", toolCallId: "c9", title: "$ cat report.md", kind: "execute", status: "pending", rawInput: { command: "cat report.md" } },
		{ sessionUpdate: "tool_call_update", toolCallId: "c9", status: "completed", content: [{ type: "content", content: { type: "text", text: "all 12 passed" } }] },
		{ sessionUpdate: "tool_call", toolCallId: "c10", title: "Reading the notes", kind: "read", status: "pending", rawInput: { path: "notes.md" } },
		{ sessionUpdate: "tool_call_update", toolCallId: "c10", status: "failed", content: [{ type: "content", content: { type: "text", text: "no such file" } }] },
		{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The eval passed." } },
	]);
	assert.deepEqual(ownTurnJobs(turn), ["python eval.py"]);
	assert.equal(ownTurnStopReason(turn), "max_tokens");
	assert.equal(ownTurnStopReason(turn.slice(0, 2)), "end_turn");
});

test("the file is read a whole line at a time, and found again by the last entry read when omp rewrites its top", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-log-"));
	const file = path.join(dir, "chat.jsonl");
	const line = value => `${JSON.stringify(value)}\n`;
	const title = text => line({ type: "title", title: text });
	const a = user("a");
	const b = reply([{ type: "text", text: "b" }]);
	const c = user("c");
	fs.writeFileSync(file, title("Old") + line(a));
	const reader = new SessionFileReader(file, fs.statSync(file).size);
	assert.deepEqual(await reader.readNew(), [], "what the file held before is not new");

	const half = line(b).slice(0, 10);
	fs.appendFileSync(file, half);
	assert.deepEqual(await reader.readNew(), [], "a line still being written waits");
	fs.appendFileSync(file, line(b).slice(10));
	assert.deepEqual(await reader.readNew(), [b]);

	// The chat's name grew: everything after it moved.
	fs.writeFileSync(file, title("A much longer name for the chat") + line(a) + line(b) + line(c));
	assert.deepEqual(await reader.readNew(), [c]);
	assert.deepEqual(await reader.readNew(), []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a chat's file is followed while omp works in the background, and its own turn is handed over when it ends", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
	fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
	const file = path.join(agentDir, "sessions", "-project", "2026-10-31T09-00-00-000Z_chat-1.jsonl");
	assert.equal(await findSessionFile("chat-1", agentDir), undefined, "a new chat's file comes with its first message");
	const write = (...entries) => fs.appendFileSync(file, entries.map(value => `${JSON.stringify(value)}\n`).join(""));
	const old = new Date(Date.now() - 60_000);
	write(entry({ type: "message", message: { role: "user", content: [] } }, old), entry({ type: "message", message: { role: "toolResult", toolCallId: "x", details: { async: { state: "running", jobId: "bg_old" } } } }, old));
	assert.equal(await findSessionFile("chat-1", agentDir), file);

	const states = [];
	const turns = [];
	const watch = new BackgroundWatch("chat-1", { changed: state => states.push(state), ownTurn: turn => turns.push(turn), log: () => {} }, agentDir, 20);
	write(user("run it"), bashCall("c1", "sleep 99"), backgrounded("c1", "bg_1"), reply([{ type: "text", text: "Running." }]));
	await watch.turnEnded();
	assert.deepEqual(states.at(-1).jobs.map(job => job.id), ["bg_1"], "an earlier run's job is not running now");
	assert.equal(watch.busy, true);

	const own = [jobResult("bg_1", "sleep 99"), reply([{ type: "text", text: "Done." }])];
	write(...own);
	const end = Date.now() + 5000;
	while (watch.busy && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(watch.busy, false, "omp is free again");
	assert.deepEqual(turns, [own]);
	assert.deepEqual(states.at(-1), { jobs: [], continuing: false });
	watch.dispose();
	fs.rmSync(agentDir, { recursive: true, force: true });
});

test("a job long past the deadline omp gave it is taken to be over; one with no deadline waits for its result", () => {
	const tracker = new SessionTracker();
	const started = new Date(Date.now() - 20 * 60_000);
	const backgroundedWith = (toolCallId, jobId, notice) =>
		entry({ type: "message", message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: `Backgrounded as job ${jobId} ${notice}; its output is injected…` }], details: { async: { state: "running", jobId, type: "bash" } } } }, started);
	tracker.apply([
		user("go"),
		entry({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "make" } }], stopReason: "toolUse" } }, started),
		backgroundedWith("c1", "bg_1", "(killed once it has run 600s in total; `timeout: 0` disables the deadline)"),
		backgroundedWith("c2", "bg_2", "(no deadline)"),
	]);
	assert.equal(tracker.jobs.get("bg_1").deadline, started.getTime() + 600_000);
	assert.equal(tracker.expire(Date.now() - 9 * 60_000), false, "within two minutes of its deadline: still running");
	assert.equal(tracker.expire(Date.now()), true);
	assert.deepEqual([...tracker.jobs.keys()], ["bg_2"]);
});

test("a helper agent started in the background is a job named after it", () => {
	const tracker = new SessionTracker();
	const spawned = entry({ type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "task", content: [{ type: "text", text: "Spawned agent `Scout` (job `Scout`)." }], details: { async: { state: "running", jobId: "Scout", type: "task" } } } });
	tracker.apply([user("look around"), spawned]);
	assert.deepEqual([...tracker.jobs.values()].map(({ id, kind, label }) => ({ id, kind, label })), [{ id: "Scout", kind: "agent", label: "Scout" }]);
});

test("a file omp replaced with a new one of the same length is read again from the last entry read", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-log-"));
	const file = path.join(dir, "chat.jsonl");
	const line = value => `${JSON.stringify(value)}\n`;
	const a = user("a");
	const b = user("b");
	fs.writeFileSync(file, line({ type: "title", title: "AAAA" }) + line(a));
	const reader = new SessionFileReader(file);
	assert.deepEqual(await reader.readNew(), [{ type: "title", title: "AAAA" }, a]);
	// Written beside it and moved over it, as omp rewrites a file: the old offset falls just after a newline again.
	fs.writeFileSync(`${file}.new`, line(a) + line({ type: "title", title: "AAAA" }) + line(b));
	fs.renameSync(`${file}.new`, file);
	assert.deepEqual(await reader.readNew(), [{ type: "title", title: "AAAA" }, b]);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a job's result read with the end of a turn asked for starts a turn of omp's own", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
	fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
	const file = path.join(agentDir, "sessions", "-project", "2026-10-31T09-00-00-000Z_chat-2.jsonl");
	const write = (...entries) => fs.appendFileSync(file, entries.map(value => `${JSON.stringify(value)}\n`).join(""));
	const states = [];
	const watch = new BackgroundWatch("chat-2", { changed: state => states.push(state), ownTurn: () => {}, log: () => {} }, agentDir, 20);
	write(user("run it"), bashCall("c1", "sleep 70"), backgrounded("c1", "bg_1"), reply([{ type: "text", text: "Running." }]), jobResult("bg_1", "sleep 70"));
	await watch.turnEnded();
	assert.equal(watch.continuing, true, "omp carries on by itself");
	assert.deepEqual(states.at(-1), { jobs: [], continuing: true });
	watch.dispose();
	fs.rmSync(agentDir, { recursive: true, force: true });
});

test("a job's result written after a turn's last reply, read already, starts a turn of omp's own when the turn ends", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
	fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
	const file = path.join(agentDir, "sessions", "-project", "2026-10-31T09-00-00-000Z_chat-3.jsonl");
	const write = (...entries) => fs.appendFileSync(file, entries.map(value => `${JSON.stringify(value)}\n`).join(""));
	const watch = new BackgroundWatch("chat-3", { changed: () => {}, ownTurn: () => {}, log: () => {} }, agentDir, 60_000);
	write(user("run it"), bashCall("c1", "sleep 70"), backgrounded("c1", "bg_1"), reply([{ type: "text", text: "Running." }]));
	await watch.refresh(); // read while the turn may still go on, e.g. by the once-a-second check
	assert.equal(watch.continuing, false);
	write(jobResult("bg_1", "sleep 70"));
	await watch.turnEnded();
	assert.equal(watch.continuing, true, "omp carries on by itself");
	watch.dispose();
	fs.rmSync(agentDir, { recursive: true, force: true });
});

test("a job's result after which omp writes nothing for three minutes is taken as no turn of omp's own; one it has replied in is not", () => {
	const tracker = new SessionTracker();
	const longAgo = new Date(Date.now() - 4 * 60_000);
	tracker.apply([user("go"), bashCall("c1", "sleep 70"), backgrounded("c1", "bg_1"), reply([{ type: "text", text: "Running." }])]);
	tracker.askedTurnEnded();
	tracker.apply([entry({ type: "custom_message", customType: "async-result", content: "done", details: { jobs: [{ jobId: "bg_1" }] } }, longAgo)]);
	assert.equal(tracker.continuing, true);
	assert.equal(tracker.endSilentTurn(Date.now() - 2 * 60_000), false, "within three minutes: omp may still be thinking");
	assert.equal(tracker.endSilentTurn(Date.now()), true);
	assert.equal(tracker.continuing, false, "messages go again");

	// omp replied (and runs a long command): its turn goes on, however quiet.
	tracker.apply([user("again"), bashCall("c2", "sleep 80"), backgrounded("c2", "bg_2"), reply([{ type: "text", text: "Running." }])]);
	tracker.askedTurnEnded();
	tracker.apply([entry({ type: "custom_message", customType: "async-result", content: "done", details: { jobs: [{ jobId: "bg_2" }] } }, longAgo), bashCall("c3", "make test")]);
	assert.equal(tracker.endSilentTurn(Date.now()), false);
	assert.equal(tracker.continuing, true);
});

test("a process omp starts runs until it exits, and its exit starts a turn of omp's own; it holds no message back", async () => {
	const tracker = new SessionTracker();
	const service = (toolCallId, name, state) =>
		entry({ type: "message", message: { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: `${name}: ${state}` }], details: { service: { name, state, pid: 1 } } } });
	tracker.apply([user("verify"), bashCall("c1", "python3 verify.py"), service("c1", "a-verify", "running"), reply([{ type: "text", text: "Started." }])]);
	tracker.askedTurnEnded();
	assert.deepEqual([...tracker.jobs.values()].map(({ id, kind, label }) => ({ id, kind, label })), [{ id: "a-verify", kind: "process", label: "a-verify" }]);
	const exited = entry({ type: "custom_message", customType: "launch-completion", content: "Supervised process a-verify exited with exit code 0.", details: { daemons: [{ name: "a-verify", state: "exited", exitCode: 0 }] } });
	const own = [exited, reply([{ type: "text", text: "Verification reproduced." }])];
	assert.deepEqual(tracker.apply(own.slice(0, 1)), []);
	assert.equal(tracker.jobs.size, 0);
	assert.equal(tracker.continuing, true);
	assert.deepEqual(tracker.apply(own.slice(1)), [own]);
	assert.deepEqual(ownTurnJobs(own), ["a-verify"]);

	// Stopped by omp in a later turn: gone too.
	tracker.apply([user("serve"), bashCall("c2", "npm run dev"), service("c2", "web", "running"), service("c3", "web", "exited"), reply([])]);
	assert.equal(tracker.jobs.size, 0);

	// A process alone keeps the file followed, but messages don't wait for it.
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
	fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
	const file = path.join(agentDir, "sessions", "-project", "2026-10-31T09-00-00-000Z_chat-4.jsonl");
	const states = [];
	const watch = new BackgroundWatch("chat-4", { changed: state => states.push(state), ownTurn: () => {}, log: () => {} }, agentDir, 20);
	fs.writeFileSync(file, [user("serve"), bashCall("c1", "npm run dev"), service("c1", "web", "running"), reply([])].map(value => `${JSON.stringify(value)}\n`).join(""));
	await watch.turnEnded();
	assert.equal(watch.busy, false, "messages go");
	assert.deepEqual(states.at(-1).jobs.map(job => job.id), ["web"], "shown in the bar");
	watch.dispose();
	fs.rmSync(agentDir, { recursive: true, force: true });
});

test("omp working on its own after a wake-up not followed here is seen from its file once it asks something", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
	fs.mkdirSync(path.join(agentDir, "sessions", "-project"), { recursive: true });
	const file = path.join(agentDir, "sessions", "-project", "2026-10-31T09-00-00-000Z_chat-5.jsonl");
	const write = (...entries) => fs.appendFileSync(file, entries.map(value => `${JSON.stringify(value)}\n`).join(""));
	const turns = [];
	const watch = new BackgroundWatch("chat-5", { changed: () => {}, ownTurn: turn => turns.push(turn), log: () => {} }, agentDir, 20);
	write(user("hi"), reply([{ type: "text", text: "Hello." }]));
	await watch.turnEnded();
	write(entry({ type: "custom_message", customType: "irc-message", content: "ping" }), bashCall("c1", "python3 compare.py"));
	await watch.ownWorkSeen(); // omp asks to run it
	assert.equal(watch.continuing, true);
	const rest = [result("c1", "bash", "done"), reply([{ type: "text", text: "Compared." }])];
	write(...rest);
	const end = Date.now() + 5000;
	while (watch.continuing && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(turns.length, 1);
	assert.deepEqual(turns[0].map(entry => entry.id).slice(1), rest.map(entry => entry.id), "its work, from the reply that asked on");
	watch.dispose();
	fs.rmSync(agentDir, { recursive: true, force: true });
});
