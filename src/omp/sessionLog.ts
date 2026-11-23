/**
 * omp's own record of a chat, a .jsonl file under ~/.omp/agent/sessions, read for what omp's ACP mode
 * doesn't tell the extension: work it moved to the background, and the turns it runs by itself when
 * that work reports back. omp writes each finished entry to the file as it happens.
 */
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "../acp/types";

/**
 * A command, helper agent or process omp runs in the background. A process (omp's supervised "service",
 * often a server) can run for hours, so unlike the others it doesn't hold messages back (see BackgroundWatch).
 */
export interface BackgroundJob {
	id: string;
	kind: "command" | "agent" | "process";
	/** The command, what omp said it does, or the process's name. */
	label: string;
	/** When omp started it (ms). */
	startedAt: number;
	/** When omp kills it, if it said (ms). */
	deadline?: number;
	/** A process's id on this machine, to see whether it still runs (see SessionTracker.dropEnded). */
	pid?: number;
}

/** How long after its deadline a job still listed is taken to be over: omp killed it, and its result went unseen. */
const PAST_DEADLINE_MS = 2 * 60_000;
/** How long after a job's result omp may take to write its first reply in a turn of its own (see endSilentTurn). */
const OWN_TURN_SILENCE_MS = 3 * 60_000;

const isReply = (entry: any): boolean => entry?.type === "message" && entry.message?.role === "assistant";

/** What omp is doing on its own: background jobs, and whether it is running a turn of its own. */
export interface BackgroundState {
	jobs: BackgroundJob[];
	continuing: boolean;
}

/** The file omp keeps this chat in, `<agent dir>/sessions/<folder>/<time>_<id>.jsonl`, if it can be found. */
export async function findSessionFile(sessionId: string, agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent")): Promise<string | undefined> {
	const root = join(agentDir, "sessions");
	const suffix = `_${sessionId}.jsonl`;
	let folders: string[];
	try {
		folders = await readdir(root);
	} catch {
		return undefined;
	}
	for (const folder of folders) {
		let names: string[];
		try {
			names = await readdir(join(root, folder));
		} catch {
			continue; // a file, or gone meanwhile
		}
		const name = names.find(name => name.endsWith(suffix));
		if (name) return join(root, folder, name);
	}
	return undefined;
}

/** Reads the entries omp adds to a chat's file, a read at a time. */
export class SessionFileReader {
	#offset: number;
	/** The start of a line omp hasn't finished writing yet. */
	#rest = Buffer.alloc(0);
	#lastId: string | undefined;
	/** The file read so far: omp rewrites a file by writing a new one in its place. */
	#inode: number | undefined;

	/** From `offset` on (bytes). */
	constructor(
		readonly path: string,
		offset = 0,
	) {
		this.#offset = offset;
	}

	/** The entries added since the last read. */
	async readNew(): Promise<any[]> {
		const { size, ino } = await stat(this.path);
		const replaced = this.#inode !== undefined && ino !== this.#inode;
		this.#inode = ino;
		if (size === this.#offset && !replaced) return [];
		// omp rewrites the file now and then (the chat's name sits at its top); when that moved what was
		// read so far, the entries after the last one read are found again by its id.
		if (replaced || size < this.#offset || !(await this.#lineStartsAt(this.#offset))) return this.#resync(size);
		const bytes = await this.#read(this.#offset, size);
		this.#offset = size;
		return this.#entries(Buffer.concat([this.#rest, bytes]));
	}

	async #lineStartsAt(offset: number): Promise<boolean> {
		const at = offset - this.#rest.length;
		if (at === 0) return true;
		const before = await this.#read(at - 1, at);
		return before[0] === 0x0a;
	}

	async #resync(size: number): Promise<any[]> {
		const lastRead = this.#lastId;
		this.#rest = Buffer.alloc(0);
		const all = this.#entries(await this.#read(0, size));
		this.#offset = size;
		const last = lastRead === undefined ? -1 : all.findIndex(entry => entry?.id === lastRead);
		return last === -1 ? [] : all.slice(last + 1); // nothing to go by: only what comes next is new
	}

	async #read(from: number, to: number): Promise<Buffer> {
		const handle = await open(this.path, "r");
		try {
			const buffer = Buffer.alloc(to - from);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, from);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	}

	/** The whole lines' entries; an unfinished last line waits for the next read. */
	#entries(bytes: Buffer): any[] {
		const end = bytes.lastIndexOf(0x0a) + 1;
		this.#rest = Buffer.from(bytes.subarray(end));
		const entries: any[] = [];
		for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// not an entry (cut by a rewrite): skipped
			}
		}
		const newest = entries.at(-1)?.id;
		if (typeof newest === "string") this.#lastId = newest;
		return entries;
	}
}

const FINISHED = new Set(["completed", "failed", "cancelled", "canceled", "aborted"]);

/**
 * Follows a chat's entries: which background jobs run, and the turns omp runs by itself. A turn
 * the extension asked for starts with the user's message and ends when the extension says so
 * (askedTurnEnded): within it, omp may stop and carry on (e.g. reminded of its to-do list). One omp
 * starts itself, with a background job's result (or a reply with no message before it), ends with
 * a reply that calls no tool.
 */
export class SessionTracker {
	readonly jobs = new Map<string, BackgroundJob>();
	#turn: "none" | "asked" | "own" = "none";
	#own: any[] = [];
	/** When the job's result that started omp's turn was written, if a result did (see endSilentTurn). */
	#ownResultAt: number | undefined;
	/** What each tool call does, and when, for the jobs they start. */
	#calls = new Map<string, { label: string; at: number }>();

	/** omp is running a turn of its own. */
	get continuing(): boolean {
		return this.#turn === "own";
	}

	/** A turn the extension asked for runs, as far as the file tells. */
	get asking(): boolean {
		return this.#turn === "asked";
	}

	/** Follow these entries; returns the entries of each turn omp ran by itself that they finish. */
	apply(entries: any[]): any[][] {
		const finished: any[][] = [];
		for (const entry of entries) {
			const ended = this.#apply(entry);
			if (ended) finished.push(ended);
		}
		return finished;
	}

	/** A turn the extension asked for has ended, so none runs now (also if the file never said so, e.g. one stopped early). */
	askedTurnEnded(): void {
		if (this.#turn === "asked") this.#turn = "none";
	}

	/** Drop the jobs well past the deadline omp gave them; true if any was. */
	expire(now: number): boolean {
		let dropped = false;
		for (const job of this.jobs.values()) {
			if (job.deadline !== undefined && now > job.deadline + PAST_DEADLINE_MS) dropped = this.jobs.delete(job.id) || dropped;
		}
		return dropped;
	}

	/**
	 * Drop the processes no longer running on this machine, whatever omp's file says (one can end
	 * without a word there). True if any was.
	 */
	dropEnded(runs: (pid: number) => boolean): boolean {
		let dropped = false;
		for (const job of [...this.jobs.values()]) {
			if (job.kind === "process" && job.pid !== undefined && !runs(job.pid)) dropped = this.jobs.delete(job.id) || dropped;
		}
		return dropped;
	}

	/**
	 * A job's result started a turn of omp's own, but omp has written no reply since, for OWN_TURN_SILENCE_MS:
	 * it isn't carrying on (e.g. it holds a result back after a turn was stopped). True if so; once omp has
	 * replied, a long command in its turn writes nothing for a while and is no sign of this.
	 */
	endSilentTurn(now: number): boolean {
		if (this.#turn !== "own" || this.#ownResultAt === undefined || this.#own.some(isReply) || now - this.#ownResultAt < OWN_TURN_SILENCE_MS) return false;
		this.#turn = "none";
		this.#own = [];
		this.#ownResultAt = undefined;
		return true;
	}

	#apply(entry: any): any[] | undefined {
		if (entry?.type === "custom" && entry.customType === "session_exit") {
			this.jobs.clear();
			this.#turn = "none";
			return undefined;
		}
		// A job's result, or a process that exited ("Supervised process a-verify exited with exit code 0."): omp carries on.
		if (entry?.type === "custom_message" && (entry.customType === "async-result" || entry.customType === "launch-completion")) {
			for (const job of arrayOf(entry.details?.jobs)) this.jobs.delete(String(job?.jobId ?? job?.id));
			for (const process of arrayOf(entry.details?.daemons)) this.jobs.delete(String(process?.name));
			if (this.#turn === "none") {
				this.#startOwn();
				this.#ownResultAt = timeOf(entry);
			}
			if (this.#turn === "own") this.#own.push(entry);
			return undefined;
		}
		if (entry?.type !== "message") return undefined;
		const message = entry.message ?? {};
		const at = timeOf(entry);
		switch (message.role) {
			case "user":
				this.#turn = "asked";
				this.#own = [];
				return undefined;
			case "assistant": {
				for (const item of arrayOf(message.content)) {
					if (item?.type === "toolCall" && typeof item.id === "string") this.#calls.set(item.id, { label: callLabel(item), at });
				}
				const done = message.stopReason !== "toolUse";
				// A stopped turn's last reply can be written once the turn has ended: not a turn of omp's own.
				if (this.#turn === "none" && !(done && (message.stopReason === "aborted" || message.stopReason === "error"))) this.#startOwn();
				if (this.#turn !== "own") return undefined;
				this.#own.push(entry);
				if (!done) return undefined;
				const own = this.#own;
				this.#turn = "none";
				this.#own = [];
				return own;
			}
			case "toolResult":
				this.#jobsOf(message, at);
				if (this.#turn === "own") this.#own.push(entry);
				return undefined;
		}
		return undefined;
	}

	#startOwn(): void {
		this.#turn = "own";
		this.#own = [];
		this.#ownResultAt = undefined;
	}

	/** Jobs a tool's result starts or reports finished. */
	#jobsOf(message: any, at: number): void {
		const call = this.#calls.get(message.toolCallId);
		this.#calls.delete(message.toolCallId); // one result per call
		const async = message.details?.async;
		if (async && typeof async.jobId === "string") {
			if (async.state === "running") {
				const startedAt = call?.at ?? at;
				// "Backgrounded as job bg_3 (killed once it has run 600s in total; …)", or "(no deadline)".
				const limit = /killed once it has run (\d+)s in total/.exec(textOf(message.content));
				this.jobs.set(async.jobId, {
					id: async.jobId,
					kind: message.toolName === "task" ? "agent" : "command",
					// A helper agent's job is named after it ("Spawned agent `Scout` (job `Scout`)").
					label: message.toolName === "task" ? async.jobId : (call?.label ?? String(message.toolName ?? "a job")),
					startedAt,
					...(limit ? { deadline: startedAt + Number(limit[1]) * 1000 } : {}),
				});
			}
			else if (FINISHED.has(async.state)) this.jobs.delete(async.jobId);
		}
		// What omp's wait tool (and others listing jobs) says about them.
		for (const job of arrayOf(message.details?.jobs)) {
			const id = job?.id ?? job?.jobId;
			if (typeof id === "string" && FINISHED.has(job.status)) this.jobs.delete(id);
		}
		// A process omp started (bash as a "service"): "a-verify: running pid=5516", until it exits.
		const service = message.details?.service;
		if (typeof service?.name === "string") {
			if (service.state === "running" || service.state === "ready") {
				const pid = typeof service.pid === "number" ? { pid: service.pid } : {};
				this.jobs.set(service.name, { id: service.name, kind: "process", label: service.name, startedAt: call?.at ?? at, ...pid });
			} else {
				this.jobs.delete(service.name);
			}
		}
		// omp's proc:// paths: a process stopped (write proc://NAME/kill) or read, and the list of them all (read proc://).
		const proc = message.details?.proc;
		if (proc) {
			const runs = (daemon: any) => daemon?.state === "running" || daemon?.state === "ready";
			if (typeof proc.daemon?.name === "string" && !runs(proc.daemon)) this.jobs.delete(proc.daemon.name);
			if (Array.isArray(proc.daemons)) {
				const running = new Set(proc.daemons.filter(runs).map((daemon: any) => daemon.name));
				for (const job of [...this.jobs.values()]) if (job.kind === "process" && !running.has(job.id)) this.jobs.delete(job.id);
			}
			for (const job of arrayOf(proc.jobs)) {
				const id = job?.id ?? job?.jobId;
				if (typeof id === "string" && FINISHED.has(job.status)) this.jobs.delete(id);
			}
		}
		// Helper agents started in the background, as older omp lists them: "- `Name` (job `Name`)".
		if (message.toolName === "task" && !async) {
			for (const match of textOf(message.content).matchAll(/\(job `([^`]+)`\)/g)) {
				this.jobs.set(match[1], { id: match[1], kind: "agent", label: match[1], startedAt: at });
			}
		}
	}
}

/** The chat page's updates for a turn omp ran by itself, as omp replays a saved chat's (session/load). */
export function ownTurnUpdates(entries: any[]): SessionUpdate[] {
	const updates: SessionUpdate[] = [];
	for (const entry of entries) {
		const message = entry?.message;
		if (entry?.type !== "message" || !message) continue;
		if (message.role === "assistant") {
			for (const item of arrayOf(message.content)) {
				if (item?.type === "text" && typeof item.text === "string" && item.text) {
					updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } } as SessionUpdate);
				} else if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim()) {
					updates.push({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: item.thinking } } as SessionUpdate);
				} else if (item?.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
					const args = argsOf(item.arguments);
					updates.push({
						sessionUpdate: "tool_call",
						toolCallId: item.id,
						title: toolTitle(item.name, args, item.intent),
						kind: toolKind(item.name),
						status: "pending",
						rawInput: args,
					} as SessionUpdate);
				}
			}
			if (message.stopReason === "error" && typeof message.errorMessage === "string") {
				updates.push({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.errorMessage } } as SessionUpdate);
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const text = textOf(message.content);
			updates.push({
				sessionUpdate: "tool_call_update",
				toolCallId: message.toolCallId,
				status: message.isError ? "failed" : "completed",
				...(text ? { content: [{ type: "content", content: { type: "text", text } }] } : {}),
				...(typeof message.details?.diff === "string" ? { rawOutput: { details: { diff: message.details.diff } } } : {}),
			} as SessionUpdate);
		}
	}
	return updates;
}

/** How the turn omp ran by itself ended, as an ACP stop reason. */
export function ownTurnStopReason(entries: any[]): string {
	const last = [...entries].reverse().find(entry => entry?.message?.role === "assistant")?.message;
	switch (last?.stopReason) {
		case "length":
			return "max_tokens";
		case "aborted":
			return "cancelled";
		default:
			return "end_turn";
	}
}

/** The jobs whose results started a turn omp ran by itself. */
export function ownTurnJobs(entries: any[]): string[] {
	return entries
		.filter(entry => entry?.type === "custom_message")
		.flatMap(entry => [
			...arrayOf(entry.details?.jobs).map(job => String(job?.label ?? job?.jobId ?? "a job")),
			...arrayOf(entry.details?.daemons).map(process => String(process?.name ?? "a process")),
		]);
}

// As omp's ACP mode titles tool calls (buildToolTitle and mapToolKind in its acp-event-mapper).
function toolTitle(name: string, args: any, intent: unknown): string {
	if ((name === "bash" || name === "shell" || name === "exec") && typeof args?.command === "string") return `$ ${args.command}`.slice(0, 4000);
	if (typeof intent === "string" && intent.trim()) return intent.trim();
	const subject = [args?.path, args?.command, args?.pattern, args?.query].find(value => typeof value === "string");
	return subject ? `${name}: ${subject}` : name;
}

function toolKind(name: string): string {
	switch (name) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "delete":
			return "delete";
		case "move":
			return "move";
		case "bash":
		case "shell":
		case "exec":
		case "eval":
			return "execute";
		case "grep":
		case "glob":
		case "ast_grep":
			return "search";
		case "web_search":
			return "fetch";
		case "todo":
			return "think";
		default:
			return "other";
	}
}

/** What a tool call does, in a few words: its command, else what omp said it does. */
function callLabel(item: any): string {
	const args = argsOf(item.arguments);
	if (typeof args?.command === "string" && args.command.trim()) return args.command.trim();
	if (typeof item.intent === "string" && item.intent.trim()) return item.intent.trim();
	return String(item.name ?? "a job");
}

function argsOf(value: unknown): any {
	if (typeof value !== "string") return value ?? {};
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return arrayOf(content)
		.map(block => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function arrayOf(value: unknown): any[] {
	return Array.isArray(value) ? value : [];
}

function timeOf(entry: any): number {
	const at = Date.parse(entry?.timestamp ?? "");
	return Number.isFinite(at) ? at : Date.now();
}
