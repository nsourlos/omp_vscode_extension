/**
 * MCP servers for an ACP session. `omp acp` ignores omp's own mcp.json on purpose (the editor owns
 * MCP), so the extension reads the same files and passes the servers in `session/new`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "../acp/types";

/** omp's own MCP config, the project's, then the project's .mcp.json (the file Claude Code uses). */
export function mcpConfigFiles(cwd: string): string[] {
	return [join(homedir(), ".omp", "agent", "mcp.json"), join(cwd, ".omp", "mcp.json"), join(cwd, ".mcp.json")];
}

interface ConfiguredServer {
	type?: string;
	command?: string;
	args?: unknown[];
	env?: Record<string, unknown>;
	url?: string;
	headers?: Record<string, unknown>;
	disabled?: boolean;
	enabled?: boolean;
}

/** `${VAR}` in a config value, filled from the environment, as Claude Code and omp do. */
function expand(value: unknown): string {
	return String(value).replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function pairs(record: Record<string, unknown> | undefined): { name: string; value: string }[] {
	return Object.entries(record ?? {}).map(([name, value]) => ({ name, value: expand(value) }));
}

/**
 * The servers in these mcp.json files (`{ "mcpServers": { name: {...} } }`), later files replacing
 * same-named servers. Missing files are skipped; unreadable ones and odd entries are reported.
 */
export function loadMcpServers(files: string[]): { servers: McpServer[]; problems: string[] } {
	const byName = new Map<string, McpServer>();
	const problems: string[] = [];
	for (const file of files) {
		let config: { mcpServers?: Record<string, ConfiguredServer> };
		try {
			config = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file}: ${(error as Error).message}`);
			continue;
		}
		for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
			if (server.disabled === true || server.enabled === false) {
				byName.delete(name);
			} else if (server.command) {
				byName.set(name, { name, command: expand(server.command), args: (server.args ?? []).map(expand), env: pairs(server.env) });
			} else if (server.url) {
				byName.set(name, { name, type: server.type === "sse" ? "sse" : "http", url: expand(server.url), headers: pairs(server.headers) });
			} else {
				problems.push(`${file}: MCP server "${name}" has neither a command nor a url`);
			}
		}
	}
	return { servers: [...byName.values()], problems };
}

/**
 * Web servers with no login header get omp's saved sign-in for their URL (made once with
 * `/mcp reauth <name>` in omp's terminal app; `omp token` refreshes it when needed). omp doesn't
 * apply saved sign-ins to servers an editor passes in, so the extension adds them as a header.
 */
export async function addSavedLogins(servers: McpServer[], savedToken: (url: string) => Promise<string | undefined>): Promise<McpServer[]> {
	const result: McpServer[] = [];
	for (const server of servers) {
		const hasLogin = "url" in server && server.headers.some(header => header.name.toLowerCase() === "authorization");
		const token = "url" in server && !hasLogin ? await savedToken(server.url) : undefined;
		if (token && "url" in server) result.push({ ...server, headers: [...server.headers, { name: "Authorization", value: `Bearer ${token}` }] });
		else result.push(server);
	}
	return result;
}

/** The servers named in omp's "name: error; name2: error" message when they failed to connect. */
export function failedMcpServers(servers: McpServer[], message: string): McpServer[] {
	return servers.filter(server => message.includes(`${server.name}:`));
}
