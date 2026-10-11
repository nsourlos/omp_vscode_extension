/**
 * Runs `omp acp` as a child process and speaks ACP to it.
 * No VS Code dependency: everything editor-specific comes in through `ClientHandlers`.
 */
import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import spawn from "cross-spawn";
import which from "which";
import { JsonRpcConnection, RpcError } from "../acp/rpc";
import {
	PROTOCOL_VERSION,
	type ConfigOption,
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

/** Full path to omp (finds omp, omp.exe, omp.cmd…), or the name itself if not found. */
export function resolveOmpCommand(configured: string): string {
	return which.sync(configured, { nothrow: true, path: searchPath() }) ?? configured;
}

export class OmpAgent {
	#process: ChildProcess | undefined;
	#rpc: JsonRpcConnection | undefined;
	#sessionId: string | undefined;
	#configOptions: ConfigOption[] = [];

	constructor(private readonly options: OmpAgentOptions) {}

	get sessionId(): string | undefined {
		return this.#sessionId;
	}

	get configOptions(): ConfigOption[] {
		return this.#configOptions;
	}

	/** Start the process, run the ACP handshake and open a fresh session. */
	async start(): Promise<NewSessionResult> {
		const { command, args, cwd, handlers } = this.options;
		const env = { ...process.env, [pathKey(process.env)]: searchPath() };
		const child = spawn(command, ["acp", ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		this.#process = child;

		let stderrTail = "";
		child.stderr!.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderrTail = (stderrTail + text).slice(-2000);
			handlers.log(`[omp stderr] ${text.trimEnd()}`);
		});
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
					handlers.onSessionUpdate(params.update);
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
			child.on("exit", code => fail(`omp exited (code ${code}). ${stderrTail.trim()}`.trim()));
		});
		exited.catch(() => {});

		const handshake = (async () => {
			await rpc.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: false,
					elicitation: { form: {} },
				},
				clientInfo: { name: "omp-vscode", version: "0.1.0" },
			});
			const session = await rpc.request<NewSessionResult>("session/new", { cwd, mcpServers: [] });
			this.#sessionId = session.sessionId;
			this.#configOptions = session.configOptions ?? [];
			return session;
		})();
		return Promise.race([handshake, exited]);
	}

	prompt(text: string): Promise<PromptResult> {
		return this.#requireRpc().request<PromptResult>("session/prompt", {
			sessionId: this.#requireSession(),
			prompt: [{ type: "text", text }],
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
