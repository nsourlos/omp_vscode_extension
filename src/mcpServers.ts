/**
 * Adding MCP servers from VS Code. They go into omp's own mcp.json (all projects, or this project's
 * .omp folder), the files omp's `/mcp add` writes: omp and this extension use them, other tools
 * like Claude Code don't. New chats pick them up.
 */
import * as vscode from "vscode";
import {
	type McpScope,
	type NewMcpServer,
	addMcpServerToFile,
	ensureMcpConfigFile,
	mcpServerNameProblem,
	mcpServerNamesIn,
	ompMcpConfigFile,
	splitCommandLine,
	suggestMcpServerName,
} from "./omp/mcp";

/** A server to add without asking (used by tests and other commands). */
export interface McpServerToAdd {
	scope: McpScope;
	name: string;
	server: NewMcpServer;
}

export function registerMcpCommands(): vscode.Disposable {
	return vscode.Disposable.from(
		// A menu passes its own argument (like the tab's address), so only a complete server skips the questions.
		vscode.commands.registerCommand("omp.addMcpServer", (preset?: unknown) => addMcpServer(isServerToAdd(preset) ? preset : undefined)),
		vscode.commands.registerCommand("omp.openMcpConfig", () => openMcpConfig()),
	);
}

function projectFolder(): string | undefined {
	return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function isServerToAdd(value: unknown): value is McpServerToAdd {
	const candidate = value as Partial<McpServerToAdd> | undefined;
	return (
		typeof candidate === "object" &&
		candidate !== null &&
		(candidate.scope === "user" || candidate.scope === "project") &&
		typeof candidate.name === "string" &&
		typeof candidate.server === "object" &&
		candidate.server !== null
	);
}

function fileFor(scope: McpScope): string {
	const folder = projectFolder();
	if (scope === "project" && !folder) throw new Error("Open a folder first to add a server for one project.");
	return ompMcpConfigFile(scope, folder ?? "");
}

/** The places omp can keep a server: all projects, and this project when a folder is open. */
function scopeItems(): { label: string; detail: string; scope: McpScope }[] {
	const folder = projectFolder();
	return [
		{ label: "All my projects", detail: ompMcpConfigFile("user", ""), scope: "user" },
		...(folder
			? [{ label: "This project only", detail: `${ompMcpConfigFile("project", folder)} (shared with anyone who gets this file)`, scope: "project" as const }]
			: []),
	];
}

const SCOPE_LABELS: Record<McpScope, string> = { user: "all your projects", project: "this project" };

/** Ask for a server (unless one is given) and add it. Resolves to the file it went into. */
async function addMcpServer(preset?: McpServerToAdd): Promise<string | undefined> {
	try {
		const choice = preset ?? (await askForServer());
		if (!choice) return undefined;
		const file = fileFor(choice.scope);
		addMcpServerToFile(file, choice.name, choice.server);
		if (!preset) void announce(choice, file);
		return file;
	} catch (error) {
		void vscode.window.showErrorMessage(`OMP: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

async function announce({ name, scope, server }: McpServerToAdd, file: string): Promise<void> {
	const signIn = server.type === "stdio" ? "" : ` If it needs a sign-in, run \`omp\` in a terminal, then \`/mcp reauth ${name}\`.`;
	const picked = await vscode.window.showInformationMessage(
		`Added the MCP server "${name}" to omp, for ${SCOPE_LABELS[scope]}. New chats can use it.${signIn}`,
		"New Chat",
		"Open File",
	);
	if (picked === "New Chat") await vscode.commands.executeCommand("omp.newSession");
	if (picked === "Open File") await vscode.window.showTextDocument(vscode.Uri.file(file));
}

async function askForServer(): Promise<McpServerToAdd | undefined> {
	const title = "Add an MCP Server to omp";
	const kind = await vscode.window.showQuickPick(
		[
			{ label: "$(terminal) Command", description: "runs on this computer", detail: "For example: npx -y @modelcontextprotocol/server-filesystem .", type: "stdio" as const },
			{ label: "$(globe) Web address", description: "HTTP", detail: "A server on the web, for example: https://mcp.example.com/mcp", type: "http" as const },
			{ label: "$(globe) Web address, older servers", description: "SSE", detail: "Servers that use server-sent events, often with a URL ending in /sse", type: "sse" as const },
		],
		{ title, placeHolder: "What kind of MCP server is it?", ignoreFocusOut: true },
	);
	if (!kind) return undefined;

	let target: string | undefined;
	if (kind.type === "stdio") {
		target = await vscode.window.showInputBox({
			title,
			prompt: "The command that starts the server, with its arguments",
			placeHolder: "npx -y @modelcontextprotocol/server-filesystem .",
			ignoreFocusOut: true,
			validateInput: value => {
				const words = splitCommandLine(value.trim());
				if (!words) return "A quote is not closed.";
				return words.length === 0 ? "Type the command." : undefined;
			},
		});
	} else {
		target = await vscode.window.showInputBox({
			title,
			prompt: "The server's web address",
			placeHolder: kind.type === "sse" ? "https://mcp.example.com/sse" : "https://mcp.example.com/mcp",
			ignoreFocusOut: true,
			validateInput: value => (/^https?:\/\/\S+$/.test(value.trim()) ? undefined : "Type a web address starting with https:// (or http://)."),
		});
	}
	if (target === undefined) return undefined;
	target = target.trim();

	const where = await vscode.window.showQuickPick(scopeItems(), { title, placeHolder: "Where should omp have it?", ignoreFocusOut: true });
	if (!where) return undefined;

	const taken = new Set(mcpServerNamesIn(fileFor(where.scope)));
	const name = await vscode.window.showInputBox({
		title,
		prompt: "A name for the server (omp shows its tools under this name)",
		value: suggestMcpServerName(kind.type, target, taken),
		ignoreFocusOut: true,
		validateInput: value => mcpServerNameProblem(value.trim()) ?? (taken.has(value.trim()) ? `There is already a server called "${value.trim()}" there.` : undefined),
	});
	if (name === undefined) return undefined;

	const secretsHint =
		where.scope === "project"
			? "This file is in the project: for a secret, write ${NAME} and set NAME in your environment."
			: "For a secret, you can write ${NAME} and set NAME in your environment instead.";
	if (kind.type === "stdio") {
		const env = await askPairs(title, `An environment variable for the server, as NAME=value. Press Enter on an empty line to finish. ${secretsHint}`, "API_KEY=${MY_API_KEY}", /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/, "Write it as NAME=value.");
		if (!env) return undefined;
		const [command, ...args] = splitCommandLine(target)!;
		return { scope: where.scope, name: name.trim(), server: { type: "stdio", command, args, env } };
	}
	const headers = await askPairs(title, `A header to send, as Name: value. Press Enter on an empty line to finish. ${secretsHint}`, "Authorization: Bearer ${MY_TOKEN}", /^([A-Za-z0-9-]+):\s*(.*)$/, "Write it as Name: value.");
	if (!headers) return undefined;
	return { scope: where.scope, name: name.trim(), server: { type: kind.type, url: target, headers } };
}

/** Ask for name/value pairs one at a time until an empty answer; undefined if cancelled. */
async function askPairs(title: string, prompt: string, placeHolder: string, pattern: RegExp, help: string): Promise<Record<string, string> | undefined> {
	const pairs: Record<string, string> = {};
	for (;;) {
		const added = Object.keys(pairs);
		const answer = await vscode.window.showInputBox({
			title: added.length ? `${title} (added: ${added.join(", ")})` : title,
			prompt,
			placeHolder,
			ignoreFocusOut: true,
			validateInput: value => (!value.trim() || pattern.test(value.trim()) ? undefined : help),
		});
		if (answer === undefined) return undefined;
		const match = pattern.exec(answer.trim());
		if (!match) return pairs;
		pairs[match[1]] = match[2];
	}
}

async function openMcpConfig(): Promise<void> {
	const picked = await vscode.window.showQuickPick(scopeItems(), {
		title: "Open omp's MCP Servers File",
		placeHolder: "Which servers do you want to see or edit?",
	});
	if (!picked) return;
	try {
		const file = fileFor(picked.scope);
		ensureMcpConfigFile(file);
		await vscode.window.showTextDocument(vscode.Uri.file(file));
	} catch (error) {
		void vscode.window.showErrorMessage(`OMP: ${error instanceof Error ? error.message : String(error)}`);
	}
}
