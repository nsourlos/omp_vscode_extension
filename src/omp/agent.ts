/**
 * Runs `omp acp` as a child process and speaks ACP to it.
 * No VS Code dependency: everything editor-specific comes in through `ClientHandlers`.
 */
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import spawn from "cross-spawn";
import which from "which";
import { AgentError, JsonRpcConnection, RpcError, withoutUrlQueries } from "../acp/rpc";
import { failedMcpServers } from "./mcp";
import {
	PROTOCOL_VERSION,
	type ConfigOption,
	type ContentBlock,
	type McpServer,
	type SavedSession,
	type ElicitationParams,
	type ElicitationResult,
	type NewSessionResult,
	type PromptResult,
	type ReadTextFileParams,
	type RequestPermissionParams,
	type RequestPermissionResult,
	type SessionUpdate,
	type WriteTextFileParams,
} from "../acp/types";

/** What the editor side must provide when the agent asks for something. */
export interface ClientHandlers {
	readTextFile(params: ReadTextFileParams): Promise<string>;
	/** Resolve once the (possibly partial) change is saved; throw to fail the agent's write. */
	writeTextFile(params: WriteTextFileParams): Promise<void>;
	requestPermission(params: RequestPermissionParams): Promise<RequestPermissionResult>;
	elicit(params: ElicitationParams): Promise<ElicitationResult>;
	onSessionUpdate(update: SessionUpdate): void;
	onExit(message: string): void;
	log(line: string): void;
}

export interface OmpAgentOptions {
	command: string;
	args: string[];
	cwd: string;
	handlers: ClientHandlers;
	/** MCP servers for the session (omp in ACP mode uses only these); may still be resolving while omp starts. */
	mcpServers?: McpServer[] | Promise<McpServer[]>;
}

/**
 * Usual omp install locations, searched after PATH (VS Code started from a GUI often has a
 * short PATH). Folders that don't exist on the current OS are simply skipped.
 */
const EXTRA_PATHS = [
	join(homedir(), ".bun", "bin"),
	...(process.env.APPDATA ? [join(process.env.APPDATA, "npm")] : []),
	"/opt/homebrew/bin",
	"/usr/local/bin",
];

/** The env key holding PATH (its casing varies by OS, e.g. "Path"). */
function pathKey(env: NodeJS.ProcessEnv): string {
	return Object.keys(env).find(key => key.toUpperCase() === "PATH") ?? "PATH";
}

/** PATH plus the usual install locations. */
function searchPath(): string {
	return [process.env[pathKey(process.env)] ?? "", ...EXTRA_PATHS].join(delimiter);
}

/** The environment omp runs in: ours, with the usual install locations added to PATH. */
export function ompEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, [pathKey(process.env)]: searchPath() };
}

/**
 * omp's saved, refreshed sign-in token for an MCP server URL (`omp token`), or undefined if there is none.
 * Run through cross-spawn like omp itself, since on Windows omp is usually an omp.cmd script.
 */
export function ompSavedToken(ompCommand: string): (url: string) => Promise<string | undefined> {
	return url =>
		new Promise(resolve => {
			const child = spawn(ompCommand, ["token", `mcp_oauth:profile:default:${url}`], { env: ompEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
			let stdout = "";
			const timer = setTimeout(() => {
				child.kill();
				resolve(undefined); // a killed omp.cmd can leave its omp holding the pipe open, so 'close' may never come
			}, 20_000);
			child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
			child.on("error", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			child.on("close", code => {
				clearTimeout(timer);
				resolve(code === 0 ? stdout.trim() || undefined : undefined);
			});
		});
}

/** The first Bun that no longer trusts the eMudhra intermediates whose keys leaked (October 2026). */
const FIRST_SAFE_BUN = [1, 4, 4];

/**
 * A warning when this Bun version still trusts the leaked eMudhra intermediates, or undefined.
 * Bun carries its own root certificates and does not check Certificate Transparency, so omp on an
 * older Bun accepts a forged certificate for any site: its API keys and replies could be intercepted.
 */
export function bunCertificateProblem(version: string): string | undefined {
	const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim())?.slice(1).map(Number);
	if (!parts) return undefined;
	const index = parts.findIndex((part, i) => part !== FIRST_SAFE_BUN[i]);
	if (index === -1 || parts[index] > FIRST_SAFE_BUN[index]) return undefined;
	return (
		`omp runs on Bun ${version.trim()}, which still trusts certificate authorities whose keys leaked in October 2026 (eMudhra), ` +
		"so someone on your network could read omp's API keys or change its replies. Run `bun upgrade` (1.4.4 or later is fixed), then start a new session."
	);
}

/** The version of the Bun omp runs on (the one on omp's PATH), or undefined if there is none. */
export function bunVersion(): Promise<string | undefined> {
	const bun = which.sync("bun", { nothrow: true, path: searchPath() });
	if (!bun) return Promise.resolve(undefined);
	return new Promise(resolve => {
		const child = spawn(bun, ["--version"], { env: ompEnvironment(), stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		const timer = setTimeout(() => {
			child.kill();
			resolve(undefined);
		}, 10_000);
		child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.on("error", () => {
			clearTimeout(timer);
			resolve(undefined);
		});
		child.on("close", code => {
			clearTimeout(timer);
			resolve(code === 0 ? stdout.trim() || undefined : undefined);
		});
	});
}

/** Full path to omp (finds omp, omp.exe, omp.cmd…), or the name itself if not found. */
export function resolveOmpCommand(configured: string): string {
	return which.sync(configured, { nothrow: true, path: searchPath() }) ?? configured;
}

/** The session updates omp replays a saved chat's conversation with. */
export const REPLAYED_UPDATES = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

export class OmpAgent {
	#process: ChildProcess | undefined;
	#rpc: JsonRpcConnection | undefined;
	#sessionId: string | undefined;
	#configOptions: ConfigOption[] = [];
	#mcpProblems: string[] = [];
	/** Rejects when the process exits; raced against every startup step. */
	#exited: Promise<never> | undefined;
	/** True while a saved chat loads whose conversation the editor already shows: omp's replay is dropped. */
	#hideReplay = false;

	constructor(private readonly options: OmpAgentOptions) {}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	get configOptions(): ConfigOption[] {
		return this.#configOptions;
	}

	/** MCP servers that would not start, so the session runs without them. */
	get mcpProblems(): string[] {
		return this.#mcpProblems;
	}

	/**
	 * Start omp and open a session: a fresh one, or, with `loadSessionId`, a saved one (omp first
	 * replays its messages as session updates, so the chat shows the conversation so far, unless
	 * `replay` is false because the chat already shows it).
	 */
	async start(loadSessionId?: string, { replay = true }: { replay?: boolean } = {}): Promise<NewSessionResult> {
		const rpc = await this.connect();
		const servers = await Promise.race([Promise.resolve(this.options.mcpServers ?? []), this.#exited!]);
		this.#hideReplay = loadSessionId !== undefined && !replay;
		const opened = this.#openSession(rpc, this.options.cwd, servers, loadSessionId).finally(() => (this.#hideReplay = false));
		const session = await Promise.race([opened, this.#exited!]);
		this.#sessionId = session.sessionId;
		this.#configOptions = session.configOptions ?? [];
		return session;
	}

	/** The chats omp has saved for this folder, newest first, every page of them (needs `connect()` or `start()`). */
	async listSessions(): Promise<SavedSession[]> {
		const sessions: SavedSession[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		do {
			const result = await this.#requireRpc().request<{ sessions?: SavedSession[]; nextCursor?: string | null }>("session/list", {
				cwd: this.options.cwd,
				...(cursor ? { cursor } : {}),
			});
			sessions.push(...(result?.sessions ?? []));
			if (cursor) seen.add(cursor);
			cursor = result?.nextCursor ?? undefined;
		} while (cursor && !seen.has(cursor)); // a repeated cursor would loop forever
		return sessions;
	}

	/** Start the process and run the ACP handshake, without opening a session. */
	async connect(): Promise<JsonRpcConnection> {
		const { command, args, cwd, handlers } = this.options;
		const env = ompEnvironment();
		const child = spawn(command, ["acp", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.#process = child;

		let stderrTail = "";
		// Logged by whole lines: a web address split across two chunks still has its query (keys) hidden.
		let stderrLine = "";
		const logStderr = (line: string) => {
			if (line.trim()) handlers.log(`[omp stderr] ${withoutUrlQueries(line.trimEnd())}`);
		};
		child.stderr!.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderrTail = (stderrTail + text).slice(-2000);
			const lines = (stderrLine + text).split("\n");
			stderrLine = lines.pop() ?? "";
			for (const line of lines) logStderr(line);
		});
		child.stderr!.on("end", () => logStderr(stderrLine));
		// A write racing omp's exit fails with EPIPE; the exit handler below reports the exit itself.
		child.stdin!.on("error", error => handlers.log(`[omp stdin] ${error.message}`));

		const rpc = new JsonRpcConnection(
			child.stdout!,
			child.stdin!,
			(method, params) => this.#handleRequest(method, params),
			(method, params) => {
				if (method === "session/update" && params?.update) {
					if (params.update.sessionUpdate === "config_option_update" && params.update.configOptions) {
						this.#configOptions = params.update.configOptions;
					}
					// Only the replayed conversation is dropped; the commands, context use and title still count.
					if (!(this.#hideReplay && REPLAYED_UPDATES.has(params.update.sessionUpdate))) handlers.onSessionUpdate(params.update);
				}
			},
			handlers.log,
		);
		this.#rpc = rpc;

		const exited = new Promise<never>((_, reject) => {
			const fail = (message: string) => {
				rpc.close(message);
				if (this.#process === child) {
					this.#process = undefined;
					this.#sessionId = undefined;
					handlers.onExit(message);
				}
				reject(new Error(message));
			};
			child.on("error", error => fail(`Could not start omp (${command}): ${error.message}`));
			// Shown in the chat: web address queries hidden, as MCP keys can ride in them (`?api_key=…`).
			child.on("exit", code => fail(`omp exited (code ${code}). ${withoutUrlQueries(stderrTail.trim())}`.trim()));
		});
		exited.catch(() => {});
		this.#exited = exited;

		const handshake = rpc.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {
				fs: { readTextFile: true, writeTextFile: true },
				terminal: false,
				elicitation: { form: {} },
			},
			clientInfo: { name: "omp-vscode", version: "0.1.0" },
		});
		await Promise.race([handshake, exited]);
		return rpc;
	}

	prompt(prompt: string | ContentBlock[]): Promise<PromptResult> {
		return this.#requireRpc().request<PromptResult>("session/prompt", {
			sessionId: this.#requireSession(),
			prompt: typeof prompt === "string" ? [{ type: "text", text: prompt }] : prompt,
		});
	}

	cancel(): void {
		if (this.#sessionId) this.#rpc?.notify("session/cancel", { sessionId: this.#sessionId });
	}

	async setConfigOption(configId: string, value: string): Promise<ConfigOption[]> {
		const result = await this.#requireRpc().request<{ configOptions?: ConfigOption[] }>(
			"session/set_config_option",
			{ sessionId: this.#requireSession(), configId, value },
		);
		if (result?.configOptions) this.#configOptions = result.configOptions;
		return this.#configOptions;
	}

	dispose(): void {
		const child = this.#process;
		this.#process = undefined;
		this.#sessionId = undefined;
		this.#rpc?.close("Session closed");
		child?.kill();
	}

	/**
	 * omp refuses a whole session when any MCP server fails to connect, so the failing ones are
	 * dropped and the session is opened again with the rest (or, if the error is about MCP but
	 * names none of them, with none). Any other error is the session's own and is passed on.
	 */
	async #openSession(rpc: JsonRpcConnection, cwd: string, servers: McpServer[], loadSessionId?: string): Promise<NewSessionResult> {
		try {
			if (!loadSessionId) return await rpc.request<NewSessionResult>("session/new", { cwd, mcpServers: servers });
			const loaded = await rpc.request<Omit<NewSessionResult, "sessionId">>("session/load", { sessionId: loadSessionId, cwd, mcpServers: servers });
			return { ...loaded, sessionId: loadSessionId };
		} catch (error) {
			// Only omp's own answer can be about MCP; omp exiting (even with "mcp" in its output) is not.
			if (servers.length === 0 || !(error instanceof AgentError)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			const failed = failedMcpServers(servers, message);
			if (failed.length === 0 && !/\bmcp\b/i.test(message)) throw error;
			this.#mcpProblems.push(`MCP servers not started: ${withoutUrlQueries(message)}`); // shown in the chat
			const rest = failed.length > 0 ? servers.filter(server => !failed.includes(server)) : [];
			return this.#openSession(rpc, cwd, rest, loadSessionId);
		}
	}

	#requireRpc(): JsonRpcConnection {
		if (!this.#rpc || !this.#process) throw new Error("omp is not running");
		return this.#rpc;
	}

	#requireSession(): string {
		if (!this.#sessionId) throw new Error("No active omp session");
		return this.#sessionId;
	}

	async #handleRequest(method: string, params: any): Promise<unknown> {
		const { handlers } = this.options;
		switch (method) {
			case "fs/read_text_file":
				return { content: await handlers.readTextFile(params) };
			case "fs/write_text_file":
				await handlers.writeTextFile(params);
				return {};
			case "session/request_permission":
				return handlers.requestPermission(params);
			case "elicitation/create":
				return handlers.elicit(params);
			default:
				throw new RpcError(-32601, `Method not supported by omp-vscode: ${method}`);
		}
	}
}
