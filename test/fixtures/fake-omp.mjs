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
//   {"hang": true}                  wait until session/cancel
//   {"exit": <code>}                exit immediately
//   {"closeStdin": true}            stop reading, so the editor's next write hits a closed pipe
// Flags: --init-delay <ms> delays the initialize reply; --log <file> appends one JSON line per outcome.
import { appendFileSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = name => {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
};
const initDelay = Number(flag("--init-delay") ?? 0);
const logFile = flag("--log");
const sessionId = `fake-${process.pid}`;

let nextId = 1;
const waiting = new Map();
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
				toolCall: { toolCallId: step.toolCallId ?? `call-${nextId}`, title: "Run a command", kind: "execute", rawInput: { command: step.permission } },
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
			// Like omp: one MCP server that won't connect fails the whole request.
			const broken = servers.filter(server => server.name.startsWith("broken"));
			if (broken.length > 0) {
				const details = broken.map(server => `${server.name}: connection refused`).join("; ");
				return send({ id: message.id, error: { code: -32603, message: "Internal error", data: { details } } });
			}
			return send({ id: message.id, result: { sessionId } });
		}
		case "session/list":
			record({ event: "session/list", cwd: message.params.cwd });
			return send({
				id: message.id,
				result: {
					sessions: [
						{ sessionId: "empty-1", cwd: message.params.cwd, title: "", updatedAt: "2026-10-02T09:00:00.000Z", _meta: { messageCount: 0 } },
						{ sessionId: "saved-1", cwd: message.params.cwd, title: "Fix the parser", updatedAt: "2026-10-01T09:00:00.000Z", _meta: { messageCount: 3 } },
					],
				},
			});
		case "session/load": {
			record({ event: "session/load", sessionId: message.params.sessionId });
			// Like omp: replay the saved conversation, then answer.
			const update = u => send({ method: "session/update", params: { sessionId: message.params.sessionId, update: u } });
			update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Why does the parser " } });
			update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "fail?" } });
			update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "It skips **empty** lines." } });
			update({ sessionUpdate: "tool_call", toolCallId: "old-1", title: "Read parser.ts", kind: "read", status: "completed" });
			return send({ id: message.id, result: {} });
		}
		case "session/prompt": {
			record({ event: "prompt", promptSessionId: message.params.sessionId });
			const text = message.params.prompt[0].text;
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
