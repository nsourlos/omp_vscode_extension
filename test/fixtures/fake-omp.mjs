#!/usr/bin/env node
// Stand-in for `omp acp` in tests: speaks just enough ACP and never calls a model.
// A prompt starting with "/" is logged as a slash command and ends the turn. Otherwise the prompt
// text is a JSON list of steps (or several, separated by a blank line), run in order (any other
// text is logged as is and ends the turn):
//   {"write": {"path", "content"}}  ask the editor to write a file
//   {"writes": [{"path", "content"}]} ask for several writes at once
//   {"elicitUrl": "<url>"}          send a URL-mode elicitation
//   {"permission": "<command>"}     ask permission to run a shell command ("toolCallId" ties it to a tool_call)
//   {"approve": "<tool>\n<details>"} send omp's "Allow tool" approval prompt
//   {"say": "<text>"}               stream a message chunk
//   {"update": {...}}               send this session/update as is (e.g. a tool_call)
//   {"nameOnRename": "<title>"}     the next "/rename" names the chat this
//   {"crashOnRename": true}         the next "/rename" exits instead (after "renameDelay" ms, if given)
//   {"hang": true}                  wait until session/cancel
//   {"untilCancelled": true}        the same, but a cancel that already came during this turn counts
//   {"exit": <code>}                exit immediately
//   {"closeStdin": true}            stop reading, so the editor's next write hits a closed pipe
//   {"noSteering": true}            refuse steering for the rest of this turn ("promptRequired")
//   {"busyFor": <n>}                answer the next n prompts "busy", like omp running a turn of its own
//   {"background": {"jobId", "command", "after", "continueFor", "reply"}}  move a command to the background;
//                                   `after` ms later (the turn has ended by then) its result comes back and omp
//                                   replies by itself `continueFor` ms later, refusing prompts meanwhile: seen
//                                   only in the chat's file; with "askDuring": "<command>", omp asks to run it
//                                   meanwhile (and replies once answered)
//   {"process": {"name", "command", "after", "continueFor", "reply", "askDuring"}}  the same with a process omp
//                                   starts (a "service"), which reports back when it exits
//   {"wake": {"after", "continueFor", "reply", "askDuring"}}  omp carries on by itself `after` ms later, woken
//                                   by something the editor isn't told of
// With PI_CODING_AGENT_DIR set, the chat is written to a file there as omp keeps it (sessions/<folder>/<time>_<id>.jsonl).
// _session/steering (adding a message to the running turn) is logged as "steer", and taken while a turn runs.
// Flags: --init-delay <ms> delays the initialize reply; --log <file> appends one JSON line per outcome;
// --fail-new <message> makes every session/new fail with that message (an error that isn't about MCP);
// --page-size <n> lists saved chats n per page, with a cursor for the next;
// --exit-on-new <text> writes the text to stderr and exits when session/new arrives.
// Loading a session whose id starts with "missing" fails, like omp's "ACP session not found";
// one starting with "flaky" fails with another error ("rate limited"), every time.
// Loading "untitled-crash" makes the "/rename" that names it exit omp.
// session/list without a cwd also lists a chat from MOVED_FOLDER (which doesn't exist) and one from the home folder.
import { appendFileSync, closeSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const MOVED_FOLDER = "/no-such-folder/renamed-project";

const args = process.argv.slice(2);
// `omp token <id>`: a saved MCP sign-in exists only for URLs containing "signed-in".
if (args[0] === "token") {
	if (args[1]?.includes("signed-in")) {
		process.stdout.write("fake-token-123\n");
		process.exit(0);
	}
	process.stderr.write("No credentials found\n");
	process.exit(1);
}
const flag = name => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const initDelay = Number(flag("--init-delay") ?? 0);
// --stderr-split: write an error line whose web address (and its key) is split across two chunks.
if (args.includes("--stderr-split")) {
	process.stderr.write("could not reach https://mcp.example/v1?api_k");
	setTimeout(() => process.stderr.write("ey=SPLIT-SECRET (timeout)\n"), 30);
}
const logFile = flag("--log");
const failNew = flag("--fail-new");
const pageSize = Number(flag("--page-size") ?? 0);
const exitOnNew = flag("--exit-on-new");
const sessionId = `fake-${process.pid}`;

let nextId = 1;
const waiting = new Map();
/** The name the next "/rename" gives the chat (set by a step, or by loading "untitled-1" or "untitled-slow"). */
let pendingName;
/** How long "/rename" takes; loading "untitled-slow" makes it slow, so a message can arrive mid-naming. */
let renameDelay = 0;
let crashOnRename = false;
let cancelTurn;
/** A cancel that came between a turn's steps, when no step waited for one: only "untilCancelled" counts it. */
let cancelledBetweenSteps = false;
/** A turn is running, so a steer can join it; and whether this turn refuses steering. */
let turnRunning = false;
let noSteering = false;
/** How many more prompts get omp's "busy" answer. */
let busyPrompts = 0;
/** omp runs a turn of its own (a background job reported back): every prompt gets the "busy" answer. */
let ownTurnRunning = false;

const chatFile = process.env.PI_CODING_AGENT_DIR
	? join(process.env.PI_CODING_AGENT_DIR, "sessions", "-fake", `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`)
	: undefined;
let nextEntryId = 1;
const writeEntry = fields => {
	if (!chatFile) return;
	mkdirSync(dirname(chatFile), { recursive: true });
	appendFileSync(chatFile, `${JSON.stringify({ id: `f${nextEntryId++}`, timestamp: new Date().toISOString(), ...fields })}\n`);
};
const writeMessage = message => writeEntry({ type: "message", message });

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const record = entry => logFile && appendFileSync(logFile, `${JSON.stringify({ sessionId, ...entry })}\n`);
const request = (method, params) =>
	new Promise(resolve => {
		const id = nextId++;
		waiting.set(id, resolve);
		send({ id, method, params });
	});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PERMISSION_OPTIONS = [
	{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
	{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
	{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
	{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
];

/** omp carrying on by itself after `wake` (an entry of its file), as after a background job or process reports back. */
async function runOwnTurn(id, wake, { askDuring, continueFor = 0, reply = "Done." }) {
	writeEntry(wake);
	ownTurnRunning = true;
	record({ event: "ownTurnStart", jobId: id });
	if (askDuring) {
		// Asked while no turn of the editor's runs. Like omp, the reply that calls the tool is written first.
		const toolCallId = `own-${id}`;
		writeMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: askDuring } }], stopReason: "toolUse" });
		const answer = await request("session/request_permission", {
			sessionId,
			toolCall: { toolCallId, title: "Run a command", kind: "execute", rawInput: { command: askDuring } },
			options: PERMISSION_OPTIONS,
		});
		record({ event: "ownPermission", result: answer.result });
		const ran = answer.result?.outcome?.optionId === "allow_once";
		writeMessage({ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text: ran ? `ran ${askDuring}` : "Rejected by user" }], isError: !ran });
	}
	await sleep(continueFor);
	writeMessage({ role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" });
	ownTurnRunning = false;
	record({ event: "backgroundDone", jobId: id });
}

async function runTurn(steps) {
	turnRunning = true;
	noSteering = false;
	try {
		return await runSteps(steps);
	} finally {
		turnRunning = false;
	}
}

async function runSteps(steps) {
	cancelledBetweenSteps = false;
	cancelTurn = undefined; // left by an earlier turn's step or "/rename"
	for (const step of steps) {
		if (step.untilCancelled) {
			record({ event: "hang" });
			if (!cancelledBetweenSteps) await new Promise(resolve => (cancelTurn = resolve));
			cancelTurn = undefined;
			return "cancelled";
		}
		if (step.write) {
			const reply = await request("fs/write_text_file", { sessionId, ...step.write });
			record({ event: "write", path: step.write.path, error: reply.error?.message });
		} else if (step.writes) {
			const replies = await Promise.all(step.writes.map(write => request("fs/write_text_file", { sessionId, ...write })));
			replies.forEach((reply, i) => record({ event: "write", path: step.writes[i].path, error: reply.error?.message }));
		} else if (step.elicitUrl) {
			const reply = await request("elicitation/create", { sessionId, mode: "url", message: "Open this", url: step.elicitUrl });
			record({ event: "elicitUrl", url: step.elicitUrl, result: reply.result });
		} else if (step.permission) {
			const reply = await request("session/request_permission", {
				sessionId,
				toolCall: { toolCallId: step.toolCallId ?? `call-${nextId}`, title: "Run a command", kind: "execute", rawInput: { command: step.permission, ...(step.cwd ? { cwd: step.cwd } : {}) } },
				options: PERMISSION_OPTIONS,
			});
			record({ event: "permission", result: reply.result });
		} else if (step.approve) {
			const reply = await request("elicitation/create", {
				sessionId,
				mode: "form",
				message: `Allow tool: ${step.approve}`,
				requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["Approve", "Deny"] } } },
			});
			record({ event: "approve", result: reply.result });
		} else if (step.say) {
			send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } } } });
		} else if (step.nameOnRename) {
			pendingName = step.nameOnRename;
			if (step.renameDelay) renameDelay = step.renameDelay;
		} else if (step.crashOnRename) {
			crashOnRename = true;
			if (step.renameDelay) renameDelay = step.renameDelay;
		} else if (step.update) {
			send({ method: "session/update", params: { sessionId, update: step.update } });
		} else if (step.hang) {
			record({ event: "hang" });
			const cancelled = await new Promise(resolve => (cancelTurn = resolve));
			cancelTurn = undefined;
			if (cancelled) return "cancelled";
		} else if (step.noSteering) {
			noSteering = true;
		} else if (step.busyFor) {
			busyPrompts = step.busyFor;
		} else if (step.background) {
			const { jobId, command, after = 1000, continueFor = 0, reply = "Done.", askDuring } = step.background;
			const toolCallId = `call-${jobId}`;
			const content = [{ type: "text", text: `Moved to the background as ${jobId}.` }];
			const details = { async: { state: "running", jobId, type: "bash" } };
			writeMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command } }], stopReason: "toolUse" });
			send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: `$ ${command}`, kind: "execute", status: "pending", rawInput: { command } } } });
			writeMessage({ role: "toolResult", toolCallId, toolName: "bash", content, details });
			send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { content, details } } } });
			const result = { type: "custom_message", customType: "async-result", content: `Background job ${jobId} has completed.`, details: { jobs: [{ jobId, type: "bash", label: command }] } };
			setTimeout(() => void runOwnTurn(jobId, result, { askDuring, continueFor, reply }), after);
		} else if (step.process) {
			const { name, command, after = 1000, continueFor = 0, reply = "Done.", askDuring } = step.process;
			const toolCallId = `call-${name}`;
			const content = [{ type: "text", text: `${name}: running pid=4242` }];
			const details = { service: { name, state: "running", ready: true, pid: 4242 } };
			writeMessage({ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command } }], stopReason: "toolUse" });
			send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: `$ ${command}`, kind: "execute", status: "pending", rawInput: { command } } } });
			writeMessage({ role: "toolResult", toolCallId, toolName: "bash", content, details });
			send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: "completed", rawOutput: { content, details } } } });
			const exited = { type: "custom_message", customType: "launch-completion", content: `Supervised process ${name} exited with exit code 0.`, details: { daemons: [{ name, state: "exited", exitCode: 0 }] } };
			setTimeout(() => void runOwnTurn(name, exited, { askDuring, continueFor, reply }), after);
		} else if (step.wake) {
			// Woken by something the editor isn't told of (here an IRC message): only its question shows.
			const { after = 1000, continueFor = 0, reply = "Done.", askDuring } = step.wake;
			const ping = { type: "custom_message", customType: "irc-message", content: "ping" };
			setTimeout(() => void runOwnTurn("wake", ping, { askDuring, continueFor, reply }), after);
		} else if (step.exit !== undefined) {
			process.exit(step.exit);
		} else if (step.closeStdin) {
			process.stdin.destroy();
			try {
				closeSync(0);
			} catch {} // already closed by destroy()
			setInterval(() => {}, 60_000); // stay alive like a hung agent
		}
	}
	return "end_turn";
}

async function handle(message) {
	switch (message.method) {
		case "initialize":
			await sleep(initDelay);
			return send({ id: message.id, result: { protocolVersion: 1 } });
		case "session/new": {
			const servers = message.params.mcpServers ?? [];
			record({ event: "session/new", cwd: message.params.cwd, mcpServers: servers.map(server => server.name) });
			if (exitOnNew) {
				process.stderr.write(`${exitOnNew}\n`);
				process.exit(1);
			}
			if (failNew) return send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: failNew } } });
			// Like omp: one MCP server that won't connect fails the whole request.
			const broken = servers.filter(server => server.name.startsWith("broken"));
			if (broken.length > 0) {
				const details = broken.map(server => `${server.name}: connection refused${server.url ? ` (${server.url})` : ""}`).join("; ");
				return send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details } } });
			}
			writeEntry({ type: "session", version: 3, cwd: message.params.cwd }); // like omp, the chat's file exists from the start
			return send({ id: message.id, result: { sessionId } });
		}
		case "session/list": {
			record({ event: "session/list", cwd: message.params.cwd, cursor: message.params.cursor });
			const here = message.params.cwd ?? process.cwd();
			const elsewhere = [
				{ sessionId: "moved-1", cwd: MOVED_FOLDER, title: "Chat from a renamed folder", updatedAt: "2026-09-20T09:00:00.000Z", _meta: { messageCount: 2 } },
				{ sessionId: "other-1", cwd: homedir(), title: "Chat from another folder", updatedAt: "2026-09-10T09:00:00.000Z", _meta: { messageCount: 2 } },
			];
			const sessions =
				here === MOVED_FOLDER
					? elsewhere.slice(0, 1)
					: [
							{ sessionId: "empty-1", cwd: here, title: "", updatedAt: "2026-10-02T09:00:00.000Z", _meta: { messageCount: 0 } },
							{ sessionId: "saved-1", cwd: here, title: "Fix the parser", updatedAt: "2026-10-01T09:00:00.000Z", _meta: { messageCount: 3 } },
							{ sessionId: "saved-0", cwd: here, title: "Oldest chat", updatedAt: "2026-09-01T09:00:00.000Z", _meta: { messageCount: 2 } },
							...(message.params.cwd ? [] : elsewhere),
						];
			if (!pageSize) return send({ id: message.id, result: { sessions } });
			const offset = Number(message.params.cursor ?? 0);
			const next = offset + pageSize < sessions.length ? String(offset + pageSize) : undefined;
			return send({ id: message.id, result: { sessions: sessions.slice(offset, offset + pageSize), nextCursor: next } });
		}
		case "session/load": {
			record({ event: "session/load", sessionId: message.params.sessionId });
			if (message.params.sessionId.startsWith("flaky")) {
				return send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: "rate limited" } } });
			}
			if (message.params.sessionId.startsWith("missing")) {
				return send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details: `ACP session not found: ${message.params.sessionId}` } } });
			}
			if (message.params.sessionId === "untitled-1") pendingName = "Named on open";
			if (message.params.sessionId === "untitled-crash") crashOnRename = true;
			if (message.params.sessionId.startsWith("untitled-slow")) {
				pendingName = "Named slowly";
				renameDelay = 1500;
			}
			// Like omp: replay the saved conversation, then answer.
			const update = u => send({ method: "session/update", params: { sessionId: message.params.sessionId, update: u } });
			update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Why does the parser " } });
			update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "fail?" } });
			update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It skips **empty** lines." } });
			update({ sessionUpdate: "tool_call", toolCallId: "old-1", title: "Read parser.ts", kind: "read", status: "completed" });
			// "crash-midload": the first load exits after replaying (a marker file remembers it); later loads finish.
			if (message.params.sessionId === "crash-midload" && logFile && !existsSync(`${logFile}.midload`)) {
				writeFileSync(`${logFile}.midload`, "");
				setTimeout(() => process.exit(1), 50);
				return;
			}
			// Like omp's updates after a load (commands, context use, title), here sent before the answer.
			if (message.params.sessionId === "with-updates") {
				update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] });
				update({ sessionUpdate: "usage_update", used: 1000, size: 100_000 });
			}
			return send({ id: message.id, result: {} });
		}
		case "_session/steering": {
			const text = message.params.prompt?.[0]?.text;
			const outcome = turnRunning && !noSteering ? "injected" : "promptRequired";
			record({ event: "steer", text, outcome });
			return send({ id: message.id, result: { outcome, queue: "steering" } });
		}
		case "session/prompt": {
			if (busyPrompts > 0 || ownTurnRunning) {
				if (!ownTurnRunning) busyPrompts--;
				record({ event: "busy" });
				const busy = "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.";
				return send({ id: message.id, error: { code: -32003, message: busy, data: { reason: "session_busy", hint: "steer|followUp|wait" } } });
			}
			// A message with attachments (a text block per file, an image block per image) is logged whole and ends the turn.
			const blocks = message.params.prompt;
			if (blocks.length > 1 || blocks[0].text?.startsWith("<attached-file")) {
				record({ event: "attachments", prompt: blocks });
				return send({ id: message.id, result: { stopReason: "end_turn" } });
			}
			const text = blocks[0].text;
			// Naming attempts stay out of the log (except a real rename), so "the latest event" stays the turn's own.
			if (text !== "/rename") record({ event: "prompt", promptSessionId: message.params.sessionId });
			if (text === "/rename") {
				// Like omp: name the chat (only when a test set a name), report it, and say so in the chat. Stop cancels it.
				const stopped = await Promise.race([sleep(renameDelay).then(() => false), new Promise(resolve => (cancelTurn = resolve))]);
				if (stopped) return send({ id: message.id, result: { stopReason: "cancelled" } });
				if (crashOnRename) process.exit(3);
				if (pendingName) {
					record({ event: "rename", title: pendingName });
					const update = u => send({ method: "session/update", params: { sessionId: message.params.sessionId, update: u } });
					update({ sessionUpdate: "session_info_update", title: pendingName });
					update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Session renamed to ${pendingName}.` } });
					pendingName = undefined;
				}
				return send({ id: message.id, result: { stopReason: "end_turn" } });
			}
			if (text.startsWith("/")) {
				record({ event: "command", text });
				return send({ id: message.id, result: { stopReason: "end_turn" } });
			}
			// Queued messages arrive joined by a blank line: one JSON list each. Any other text (like a
			// rejected command's note, which the extension writes) is logged and ends the turn.
			writeMessage({ role: "user", content: [{ type: "text", text }] });
			let steps;
			try {
				steps = text.split("\n\n").flatMap(part => JSON.parse(part));
			} catch {
				record({ event: "text", text });
				writeMessage({ role: "assistant", content: [], stopReason: "stop" });
				return send({ id: message.id, result: { stopReason: "end_turn" } });
			}
			const stopReason = await runTurn(steps);
			writeMessage({ role: "assistant", content: [], stopReason: stopReason === "cancelled" ? "aborted" : "stop" });
			return send({ id: message.id, result: { stopReason } });
		}
		case "session/cancel":
			if (cancelTurn) return cancelTurn(true);
			// A cancel with no turn of the editor's running: in omp, it would stop omp's own work.
			if (!turnRunning) record({ event: "idleCancel" });
			cancelledBetweenSteps = true;
			return;
	}
}

createInterface({ input: process.stdin }).on("line", line => {
	const message = JSON.parse(line);
	if (message.method === undefined) {
		waiting.get(message.id)?.(message);
		waiting.delete(message.id);
		return;
	}
	void handle(message);
});
