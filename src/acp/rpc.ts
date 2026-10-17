/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams — the transport ACP uses over stdio.
 * Handles both directions: our requests to the agent, and the agent's requests to us.
 */
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";

export type RequestHandler = (method: string, params: any) => Promise<unknown>;
export type NotificationHandler = (method: string, params: any) => void;

/** Error a request handler can throw to send a specific JSON-RPC error back. */
export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** The agent answered a request with an error (as opposed to the connection closing). */
export class AgentError extends Error {}

/**
 * A session request's line for the log, with each MCP server reduced to its name and type: tokens
 * and keys can be anywhere in a server's env, headers, args or url (`?api_key=…`).
 */
function loggable(message: Record<string, unknown>): string {
	return JSON.stringify({ jsonrpc: "2.0", ...message }, (key, value) =>
		key === "mcpServers" && Array.isArray(value)
			? value.map(server => ({ name: server?.name, type: server?.type ?? (server?.command ? "stdio" : undefined) }))
			: value,
	);
}

/** A log line with the query of every web address hidden: MCP keys often ride in it (`?api_key=…`), and omp's errors can repeat it. */
export function withoutUrlQueries(line: string): string {
	return line.replace(/(https?:\/\/[^\s"'?#]*)\?[^\s"'#]*/g, "$1?…");
}

interface Pending {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
}

export class JsonRpcConnection {
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#closed = false;

	constructor(
		input: Readable,
		private readonly output: Writable,
		private readonly onRequest: RequestHandler,
		private readonly onNotification: NotificationHandler,
		private readonly log: (line: string) => void = () => {},
	) {
		createInterface({ input }).on("line", line => this.#handleLine(line));
	}

	request<T = any>(method: string, params: unknown): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("Connection closed"));
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#send({ id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.#closed) return;
		this.#send({ method, params });
	}

	/** Reject every in-flight request; called when the agent process exits. */
	close(reason: string): void {
		this.#closed = true;
		for (const pending of this.#pending.values()) pending.reject(new Error(reason));
		this.#pending.clear();
	}

	#send(message: Record<string, unknown>): void {
		if (this.#closed) return;
		const line = JSON.stringify({ jsonrpc: "2.0", ...message });
		// Only these carry MCP secrets; everything else (like a large file read) is logged as sent.
		const secret = message.method === "session/new" || message.method === "session/load";
		this.log(`→ ${secret ? loggable(message) : withoutUrlQueries(line)}`);
		this.output.write(`${line}\n`);
	}

	#handleLine(line: string): void {
		if (!line.trim()) return;
		this.log(`← ${withoutUrlQueries(line)}`);
		let message: any;
		try {
			message = JSON.parse(line);
		} catch {
			return; // stray non-protocol output
		}

		// Response to one of our requests.
		if (message.method === undefined && message.id !== undefined) {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.error) {
				// omp often says only "Internal error" and puts the cause in data.details.
				const details = message.error.data?.details;
				const text = message.error.message ?? "Agent error";
				pending.reject(new AgentError(typeof details === "string" && details ? `${text}: ${details}` : text));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		// Notification from the agent.
		if (message.id === undefined) {
			try {
				this.onNotification(message.method, message.params);
			} catch (error) {
				this.log(`notification handler failed: ${String(error)}`);
			}
			return;
		}

		// Request from the agent: answer it, whatever happens.
		this.onRequest(message.method, message.params).then(
			result => this.#send({ id: message.id, result: result ?? {} }),
			error => {
				const code = error instanceof RpcError ? error.code : -32603;
				const text = error instanceof Error ? error.message : String(error);
				this.#send({ id: message.id, error: { code, message: text } });
			},
		);
	}
}
