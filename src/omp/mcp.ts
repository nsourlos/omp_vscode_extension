/**
 * MCP servers for an ACP session. `omp acp` ignores omp's own mcp.json on purpose (the editor owns
 * MCP), so the extension reads the same files and passes the servers in `session/new`.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { McpServer } from "../acp/types";

/** Where omp keeps its own MCP servers: for all of the user's projects, or for one project. */
export type McpScope = "user" | "project";

/** omp's own mcp.json for a scope (the files its `/mcp add` writes; other tools don't read them). */
export function ompMcpConfigFile(scope: McpScope, cwd: string): string {
	return scope === "user" ? join(homedir(), ".omp", "agent", "mcp.json") : join(cwd, ".omp", "mcp.json");
}

/**
 * omp's own MCP config, the project's, then the project's .mcp.json (the file Claude Code uses).
 * A project's servers are commands it chose, so they are used only in a trusted workspace.
 */
export function mcpConfigFiles(cwd: string, trusted: boolean): string[] {
	const user = ompMcpConfigFile("user", cwd);
	return trusted ? [user, ompMcpConfigFile("project", cwd), join(cwd, ".mcp.json")] : [user];
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

/** `${VAR}` and `${VAR:-default}` (used when VAR is unset or empty) in a config value, filled from the environment, as Claude Code does. */
function expand(value: unknown): string {
	return String(value).replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) =>
		fallback === undefined ? (process.env[name] ?? "") : process.env[name] || fallback,
	);
}

function pairs(record: Record<string, unknown> | undefined): { name: string; value: string }[] {
	return Object.entries(record ?? {}).map(([name, value]) => ({ name, value: expand(value) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What is wrong with a server entry's shape, or undefined if it can be used. */
function shapeProblem(server: unknown): string | undefined {
	if (!isRecord(server)) return "is not an object";
	if (server.args !== undefined && !Array.isArray(server.args)) return `has "args" that is not a list`;
	for (const key of ["env", "headers"]) {
		if (server[key] !== undefined && !isRecord(server[key])) return `has "${key}" that is not an object`;
	}
	return undefined;
}

/**
 * The servers in these mcp.json files (`{ "mcpServers": { name: {...} } }`), later files replacing
 * same-named servers. Missing files are skipped; unreadable ones and odd entries are reported.
 * Like omp, only the user's own config (listed first) can turn servers off with its "disabledServers"
 * list; a project's list is ignored. (A project's file can still replace or turn off a server of the
 * same name, as later files do, in omp and Claude Code alike.)
 */
export function loadMcpServers(files: string[], { userConfig = files[0] }: { userConfig?: string } = {}): { servers: McpServer[]; problems: string[] } {
	const byName = new Map<string, McpServer>();
	const problems: string[] = [];
	const disabled = new Set<string>();
	for (const file of files) {
		let config: unknown;
		try {
			config = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") problems.push(`${file}: ${(error as Error).message}`);
			continue;
		}
		const configured = isRecord(config) ? (config.mcpServers ?? {}) : undefined;
		if (!isRecord(configured)) {
			problems.push(`${file}: "mcpServers" should be an object of servers by name`);
			continue;
		}
		// Turned off with omp's `/mcp disable <name>`, which lists the name here rather than editing the server.
		const disabledList = (config as Record<string, unknown>).disabledServers;
		if (file === userConfig && Array.isArray(disabledList)) for (const name of disabledList) if (typeof name === "string") disabled.add(name);
		for (const [name, entry] of Object.entries(configured)) {
			const problem = shapeProblem(entry);
			if (problem) {
				problems.push(`${file}: MCP server "${name}" ${problem}`);
				continue;
			}
			const server = entry as ConfiguredServer;
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
	return { servers: [...byName.values()].filter(server => !disabled.has(server.name)), problems };
}

/** Why omp would refuse this server name (its own rule), or undefined if it is fine. */
export function mcpServerNameProblem(name: string): string | undefined {
	if (!name) return "Give the server a name.";
	if (name.length > 100) return "That name is too long (at most 100 characters).";
	if (!/^[a-zA-Z0-9_.:-]+(?: [a-zA-Z0-9_.:-]+)*$/.test(name)) return "Use only letters, numbers, - _ . : and single spaces.";
	return undefined;
}

/**
 * A command line as its words: spaces separate words, quotes group them, and a backslash escapes
 * a space or a quote. Any other backslash is kept, so Windows paths (C:\tools\server.js, and
 * network paths like \\server\share) survive. Undefined if a quote is left open.
 */
export function splitCommandLine(line: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote) quote = undefined;
			else if (c === "\\" && quote === '"' && line[i + 1] === '"') word += line[++i];
			else word += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === "\\" && /[\s'"]/.test(line[i + 1] ?? "")) {
			word += line[++i];
			inWord = true;
		} else if (/\s/.test(c)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += c;
			inWord = true;
		}
	}
	if (quote) return undefined;
	if (inWord) words.push(word);
	return words;
}

/** A server as omp's mcp.json stores it. */
export type NewMcpServer =
	| { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
	| { type: "http" | "sse"; url: string; headers: Record<string, string> };

/** The servers already in one mcp.json, by name (none if the file doesn't exist yet). */
export function mcpServerNamesIn(file: string): string[] {
	const config = readConfigForWriting(file);
	return Object.keys(isRecord(config.mcpServers) ? config.mcpServers : {});
}

function readConfigForWriting(file: string): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON (${(error as Error).message}). Fix or remove it first.`);
	}
	if (!isRecord(config) || (config.mcpServers !== undefined && !isRecord(config.mcpServers))) {
		throw new Error(`${file} doesn't look like an MCP config ("mcpServers" should be an object). Fix it first.`);
	}
	return config;
}

/** The schema omp puts in the mcp.json files it writes, so editors can check them. */
const OMP_MCP_SCHEMA = "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

/**
 * Add a server to one of omp's mcp.json files, as omp's own `/mcp add` does: everything else in
 * the file is kept, an existing server of that name is never replaced, and the file is replaced
 * in one step (it may hold keys, so only its owner can read it).
 */
export function addMcpServerToFile(file: string, name: string, server: NewMcpServer): void {
	const nameProblem = mcpServerNameProblem(name);
	if (nameProblem) throw new Error(nameProblem);
	const config = readConfigForWriting(file);
	const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
	if (Object.hasOwn(servers, name)) throw new Error(`There is already an MCP server called "${name}" in ${file}.`);
	const entry =
		server.type === "stdio"
			? { command: server.command, ...(server.args.length ? { args: server.args } : {}), ...(Object.keys(server.env).length ? { env: server.env } : {}) }
			: { type: server.type, url: server.url, ...(Object.keys(server.headers).length ? { headers: server.headers } : {}) };
	writeConfig(file, { $schema: OMP_MCP_SCHEMA, ...config, mcpServers: { ...servers, [name]: entry } });
}

/** Create an empty omp mcp.json if there is none yet, so it can be opened and edited. */
export function ensureMcpConfigFile(file: string): void {
	try {
		readFileSync(file); // there is a file (perhaps one with a mistake, to be fixed in the editor): leave it as it is
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		writeConfig(file, { $schema: OMP_MCP_SCHEMA, mcpServers: {} });
	}
}

/** The file a path really names: through a symlink (say into a dotfiles repo), so writing keeps the link. */
function linkTarget(file: string): string {
	try {
		return realpathSync(file);
	} catch {} // no file yet, or a link to a file that doesn't exist yet
	try {
		return resolve(dirname(file), readlinkSync(file));
	} catch {
		return file;
	}
}

function writeConfig(path: string, config: Record<string, unknown>): void {
	const file = linkTarget(path);
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

/**
 * Web servers with no login header get omp's saved sign-in for their URL (made once with
 * `/mcp reauth <name>` in omp's terminal app; `omp token` refreshes it when needed). omp doesn't
 * apply saved sign-ins to servers an editor passes in, so the extension adds them as a header.
 */
export function addSavedLogins(servers: McpServer[], savedToken: (url: string) => Promise<string | undefined>): Promise<McpServer[]> {
	// Looked up all at once, so slow sign-ins delay the start by the slowest one, not their sum.
	return Promise.all(
		servers.map(async server => {
			if (!("url" in server) || server.headers.some(header => header.name.toLowerCase() === "authorization")) return server;
			const token = await savedToken(server.url);
			return token ? { ...server, headers: [...server.headers, { name: "Authorization", value: `Bearer ${token}` }] } : server;
		}),
	);
}

/**
 * The servers named in omp's message when they failed to connect. omp joins `name: error` entries
 * with "; ", and the reply may start with "Internal error: ", so a name counts only at the start,
 * after "; " or after ": ": "cloud" is not taken from "jira-cloud: …", "server" not from
 * "my server: …", and a server called "error" not from "Internal error: …".
 */
export function failedMcpServers(servers: McpServer[], message: string): McpServer[] {
	const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return servers.filter(server => new RegExp(`(^|; |: )${escape(server.name)}:`).test(message));
}

/** A name from the package or the web address ("@scope/server-github" → "github", "mcp.atlassian.com" → "atlassian"). */
export function suggestMcpServerName(type: NewMcpServer["type"], target: string, taken: Set<string> = new Set()): string {
	let base = "";
	if (type === "stdio") {
		const words = splitCommandLine(target) ?? [];
		const candidates = words.slice(1).filter(word => !word.startsWith("-") && /[a-z]/i.test(word));
		const packageWord = candidates.find(word => /mcp|server/i.test(word)) ?? candidates[0];
		base = (packageWord ?? words[0] ?? "")
			.replace(/@[^@/]*$/, "") // a version
			.split(/[\\/]/) // a package path, or a path on any system
			.pop()!
			.replace(/^(mcp-server-|server-|mcp-)/, "")
			.replace(/(-mcp-server|-server|-mcp)$/, "");
	} else {
		try {
			const host = new URL(target).hostname;
			if (host === "localhost" || host.startsWith("[") || /^[\d.]+$/.test(host)) {
				base = "local"; // an IP address or this computer: no name to take from it
			} else {
				const labels = host.split(".").filter(label => !["mcp", "www", "api"].includes(label));
				// example.co.uk: the name is before the two-part ending
				const twoPartEnding = labels.length >= 3 && labels.at(-1)!.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(labels.at(-2)!);
				base = labels.at(twoPartEnding ? -3 : -2) ?? labels[0] ?? "";
			}
		} catch {}
	}
	base = base.replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
	let name = base;
	for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
	return name;
}
