/** Plain-logic rules shared by the extension: prompts, shell heuristics, agent-facing messages. */
import { describeHunk, type Hunk } from "../review/hunks";

/** Appended to omp's system prompt when `omp.preferEditTool` is on. */
export const PREFER_EDIT_TOOL_PROMPT = [
	"File changes in this session are reviewed by the user in VS Code.",
	"Always create or modify files with your edit tool (or write, for brand-new files).",
	"Never change files through shell commands: no sed -i, perl -i, echo/cat/printf redirection, tee, heredocs, or scripts that write files.",
	"Use the shell only for running, building, testing and inspecting.",
	"The user reviews each edit as a diff, change by change, and may accept only some changes.",
	"If an edit result says changes were rejected, treat them as not wanted: do not ask why, do not re-apply them, and continue with the rest of the task; read the file again before editing it further.",
].join(" ");

/** Commands that probably modify files, and so would skip the diff review. */
const FILE_CHANGING_PATTERNS: { pattern: RegExp; label: string }[] = [
	{ pattern: /\bsed\b[^|;&]*\s-[a-zA-Z]*i/, label: "sed -i" },
	{ pattern: /\bperl\b[^|;&]*\s-[a-zA-Z]*i/, label: "perl -i" },
	{ pattern: /(^|[^0-9&<>-])>>?\s*(?!&|\/dev\/null)[^\s&|;]/, label: "output redirection (>)" },
	{ pattern: /\btee\b/, label: "tee" },
	{ pattern: /<<-?\s*['"]?\w+/, label: "heredoc" },
	{ pattern: /(^|[\s;&|(])(rm|mv|cp|touch|truncate|rmdir|mkdir|ln|chmod|chown|dd|install|unzip|tar\s+-?x)\b/, label: "file command" },
	{ pattern: /\bgit\s+(checkout|restore|reset|apply|am|stash|clean|mv|rm|merge|rebase|cherry-pick|revert|pull)\b/, label: "git command that changes files" },
	{ pattern: /\bpatch\b/, label: "patch" },
	{ pattern: /\b(python3?|node|ruby|bun|deno)\b[^|;&]*\s-(c|e)\b/, label: "inline script" },
];

/** Returns why a shell command looks like it changes files, or undefined. */
export function fileChangeWarning(command: string): string | undefined {
	const hits = FILE_CHANGING_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(({ label }) => label);
	if (hits.length === 0) return undefined;
	return `This command may change files without a diff review (${[...new Set(hits)].join(", ")}).`;
}

/** Parse omp's generic approval prompt ("Allow tool: edit\nFile: x"). */
export function parseApprovalMessage(message: string): { toolName: string; details: string } | undefined {
	const match = /^Allow tool:\s*(\S+)\s*\n?([\s\S]*)$/.exec(message.trim());
	if (!match) return undefined;
	return { toolName: match[1], details: match[2].trim() };
}

/** Tools whose output always passes through our diff review before it is saved. */
export const DIFF_REVIEWED_TOOLS = new Set(["edit", "write"]);

/** Message returned to the agent (as a failed write) when the user rejected some or all hunks. */
export function rejectionMessage(displayPath: string, hunks: Hunk[], accepted: readonly boolean[]): string {
	const rejected = hunks.filter((_, i) => !accepted[i]);
	const acceptedCount = hunks.length - rejected.length;
	const lines: string[] = [];
	if (acceptedCount === 0) {
		lines.push(`The user rejected this change to ${displayPath}. The file was NOT modified.`);
	} else {
		lines.push(
			`The user reviewed this change to ${displayPath} and accepted ${acceptedCount} of ${hunks.length} hunks.`,
			"The accepted hunks ARE saved in the file. The rejected hunks below were NOT applied:",
		);
	}
	if (acceptedCount > 0 || hunks.length > 1) {
		for (const hunk of rejected) lines.push("", describeHunk(hunk));
	}
	lines.push(
		"",
		"The user does not want the rejected changes and gave no further explanation. Do not ask why and do not re-apply them or try an alternative to them.",
		"Continue with the rest of the task. Read the file again before editing it further.",
	);
	return lines.join("\n");
}
