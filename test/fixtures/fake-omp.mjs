#!/usr/bin/env node
// Stand-in for `omp acp` in tests: speaks just enough ACP and never calls a model.
// A prompt starting with "/" is logged as a slash command and ends the turn. Otherwise the prompt
// text is a JSON list of steps (or several, separated by a blank line), run in order:
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
//   {"exit": <code>}                exit immediately
//   {"closeStdin": true}            stop reading, so the editor's next write hits a closed pipe
// Flags: --init-delay <ms> delays the initialize reply; --log <file> appends one JSON line per outcome;
// --fail-new <message> makes every session/new fail with that message (an error that isn't about MCP);
// --page-size <n> lists saved chats n per page, with a cursor for the next;
// --exit-on-new <text> writes the text to stderr and exits when session/new arrives.
// Loading a session whose id starts with "missing" fails, like omp's "ACP session not found";
// one starting with "flaky" fails with another error ("rate limited"), every time.
// Loading "untitled-crash" makes the "/rename" that names it exit omp.
import { appendFileSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";

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

const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const record = entry => logFile && appendFileSync(logFile, `${JSON.stringify({ sessionId, ...entry })}\n`);
const request = (method, params) =>
	new Promise(resolve => {
		const id = nextId++;
		waiting.set(id, resolve);
		send({ id, method, params });
	});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runTurn(steps) {
	for (const step of steps) {
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
				options: [
					{ optionId: "allow_once", name: "Allow once", kind: "allow_once" },
					{ optionId: "allow_always", name: "Always allow", kind: "allow_always" },
					{ optionId: "reject_once", name: "Reject", kind: "reject_once" },
					{ optionId: "reject_always", name: "Always reject", kind: "reject_always" },
				],
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
			if (cancelled) return "cancelled";
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
			return send({ id: message.id, result: { sessionId } });
		}
		case "session/list": {
			record({ event: "session/list", cwd: message.params.cwd, cursor: message.params.cursor });
			const sessions = [
				{ sessionId: "empty-1", cwd: message.params.cwd, title: "", updatedAt: "2026-10-02T09:00:00.000Z", _meta: { messageCount: 0 } },
				{ sessionId: "saved-1", cwd: message.params.cwd, title: "Fix the parser", updatedAt: "2026-10-01T09:00:00.000Z", _meta: { messageCount: 3 } },
				{ sessionId: "saved-0", cwd: message.params.cwd, title: "Oldest chat", updatedAt: "2026-09-01T09:00:00.000Z", _meta: { messageCount: 2 } },
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
			// Like omp's updates after a load (commands, context use, title), here sent before the answer.
			if (message.params.sessionId === "with-updates") {
				update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "compact", description: "Compact" }] });
				update({ sessionUpdate: "usage_update", used: 1000, size: 100_000 });
			}
			return send({ id: message.id, result: {} });
		}
		case "session/prompt": {
			const text = message.params.prompt[0].text;
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
			// Queued messages arrive joined by a blank line: one JSON list each.
			const steps = text.split("\n\n").flatMap(part => JSON.parse(part));
			const stopReason = await runTurn(steps);
			return send({ id: message.id, result: { stopReason } });
		}
		case "session/cancel":
			return cancelTurn?.(true);
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
