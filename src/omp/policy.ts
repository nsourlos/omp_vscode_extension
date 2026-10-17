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
	{ pattern: /\bsed\b[^|;&]*\s(-[a-zA-Z]*i|--in-place)/, label: "sed -i" },
	{ pattern: /\bperl\b[^|;&]*\s-[a-zA-Z]*i/, label: "perl -i" },
	{ pattern: /(^|[^0-9&<>-])>>?\s*(?!&|\/dev\/null)[^\s&|;]/, label: "output redirection (>)" },
	{ pattern: /\btee\b/, label: "tee" },
	{ pattern: /<<-?\s*['"]?\w+/, label: "heredoc" },
	{ pattern: /(^|[\s;&|(])(rm|mv|cp|touch|truncate|rmdir|mkdir|ln|chmod|chown|dd|unzip)\b/, label: "file command" },
	{ pattern: /(^|[;&|(]\s*)install\s/, label: "file command" },
	{ pattern: /\btar\s+(-?[a-zA-Z]*x|[^|;&]*--extract)/, label: "tar extract" },
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

/** Commands that only read or navigate; anything not listed here is never auto-allowed. */
const READ_ONLY_COMMANDS = new Set(["cd", "pwd", "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "git", "echo"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show"]);
/** Options that make an otherwise read-only command write files or run another program. */
const WRITING_FLAGS = /^(-exec|-execdir|-ok|-okdir|-delete|-fprint\w*|-fls|--output(=.*)?)$/;
/** ripgrep options that start other programs: a preprocessor, a hostname helper, decompressors (-z). */
const RG_RUNS_PROGRAMS = /^(--pre|--hostname-bin|--search-zip)(=.*)?$|^-[a-zA-Z]*z/;
/** Redirections that only discard output or merge it into the pipe. */
const HARMLESS_REDIRECT = /^(\d|&)?>>?\s*\/dev\/null$|^\d>&\d$/;

/** Unquoted characters that make bash expand a word into other words (globs and braces). */
const EXPANDING = new Set(["*", "?", "[", "{"]);

/**
 * Splits a shell command into its simple commands (by ;, &&, ||, |, newlines), each as a list of
 * words, honouring quotes and backslashes. Returns undefined for anything it will not judge:
 * command substitution, variables, subshells, backgrounding, here-docs, a redirection other than
 * to /dev/null, or a glob or brace that could expand into an option (one not anchored by a
 * leading path or name, like `*.ts` or `{-delete,-print}`, rather than `src/*.ts`).
 */
function splitCommand(command: string): string[][] | undefined {
	const commands: string[][] = [[]];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | undefined;
	/** The word may expand, and what it starts with could become an option after expansion. */
	let expands = false;
	let unanchored = false;
	let refused = false;
	const addToWord = (c: string, expanding = false) => {
		if (word === "") unanchored = expanding || c === "-";
		if (expanding) expands = true;
		word += c;
		inWord = true;
	};
	const endWord = () => {
		if (expands && unanchored) refused = true;
		if (inWord) commands.at(-1)!.push(word);
		word = "";
		inWord = false;
		expands = false;
		unanchored = false;
	};
	for (let i = 0; i < command.length; i++) {
		const c = command[i];
		if (quote === "'") {
			if (c === "'") quote = undefined;
			else addToWord(c);
			continue;
		}
		// Command substitution runs another command; a variable's value (even ${IFS}) is not known here.
		if (c === "`" || c === "$") return undefined;
		if (c === "\\") {
			// A line continuation: bash deletes it and joins the word ("-ex\<newline>ec" is -exec).
			if (command[i + 1] === "\n" || command[i + 1] === "\r") return undefined;
			addToWord(command[++i] ?? "");
			continue;
		}
		if (quote === '"') {
			if (c === '"') quote = undefined;
			else addToWord(c);
			continue;
		}
		if (c === "(" || c === ")") return undefined; // subshells and extended globs
		if (c === "'" || c === '"') {
			quote = c;
			inWord = true;
		} else if (c === " " || c === "\t") {
			endWord();
		} else if (c === ";" || c === "\n" || c === "|" || c === "&") {
			const pair = command.slice(i, i + 2);
			if (c === "&" && pair !== "&&" && !/^&>/.test(pair)) return undefined; // backgrounding
			if (c === "&" && pair !== "&&") {
				addToWord(c); // part of "&>/dev/null"
				continue;
			}
			endWord();
			if (pair === "&&" || pair === "||") i++;
			commands.push([]);
		} else if (c === ">" || c === "<") {
			if (c === "<") return undefined; // input redirection and here-docs: not judged
			const target = /^>>?\s*\S+/.exec(command.slice(i))?.[0];
			if (!target) return undefined; // nothing to redirect to: not valid shell
			const redirect = (inWord ? word : "") + target;
			if (!HARMLESS_REDIRECT.test(redirect.replace(/\s+/g, ""))) return undefined;
			word = "";
			inWord = false;
			expands = false;
			unanchored = false;
			i += target.length - 1;
		} else {
			addToWord(c, EXPANDING.has(c));
		}
	}
	if (quote) return undefined;
	endWord();
	if (refused) return undefined;
	return commands.filter(words => words.length > 0);
}

/** True when every part of a shell command only reads or navigates (see READ_ONLY_COMMANDS). */
export function isReadOnlyCommand(command: string): boolean {
	const commands = splitCommand(command);
	if (!commands || commands.length === 0) return false;
	// After a `cd`, git reads that folder's own repository settings, and a planted repository's
	// settings (core.fsmonitor, diff.external) run programs.
	if (commands.some(([name]) => name === "cd") && commands.some(([name]) => name === "git")) return false;
	return commands.every(([name, ...args]) => {
		if (!READ_ONLY_COMMANDS.has(name)) return false; // also rules out "VAR=x cmd" and paths to programs
		if (name === "git" && !READ_ONLY_GIT.has(args[0])) return false;
		if (name === "rg" && args.some(arg => RG_RUNS_PROGRAMS.test(arg))) return false;
		return !args.some(arg => WRITING_FLAGS.test(arg));
	});
}

/** Parse omp's generic approval prompt ("Allow tool: edit\nFile: x"). */
export function parseApprovalMessage(message: string): { toolName: string; details: string } | undefined {
	const match = /^Allow tool:\s*(\S+)\s*\n?([\s\S]*)$/.exec(message.trim());
	if (!match) return undefined;
	return { toolName: match[1], details: match[2].trim() };
}

/** The code an eval tool call runs (one `code` string, or `cells` each with code), or undefined. */
export function codeOfToolInput(rawInput: unknown): string | undefined {
	if (typeof rawInput !== "object" || rawInput === null) return undefined;
	const input = rawInput as { code?: unknown; cells?: unknown };
	if (typeof input.code === "string") return input.code;
	if (!Array.isArray(input.cells)) return undefined;
	const codes: string[] = [];
	for (const cell of input.cells) {
		if (typeof cell?.code === "string") codes.push(cell.code);
	}
	if (codes.length === 0) return undefined;
	return codes.join("\n\n");
}

/**
 * The distinct web addresses written out in full in a piece of code, in order, and whether any
 * other address is built from a variable (its real value is not in the code, so it is left out).
 */
export function urlsIn(text: string): { urls: string[]; someHidden: boolean } {
	const urls: string[] = [];
	let someHidden = false;
	for (const match of text.matchAll(/https?:\/\/[^\s"'`<>()[\]{}]*/g)) {
		const after = text.slice(match.index + match[0].length);
		let built = false;
		if (match[0].endsWith("//")) built = true; // "https://" + host
		if (after.startsWith("{")) built = true; // `https://${host}`, f"https://{host}", "https://{}".format(host)
		if (match[0].includes("%s") || match[0].endsWith("%")) built = true; // "https://%s" % host, "%(name)s"
		if (/^["'`]\s*\+/.test(after)) built = true; // "https://example.com/" + path
		if (built) someHidden = true;
		else urls.push(match[0].replace(/[.,;:]+$/, ""));
	}
	return { urls: [...new Set(urls)], someHidden };
}

/** Tools whose output always passes through our diff review before it is saved. */
export const DIFF_REVIEWED_TOOLS = new Set(["edit", "write"]);

/** Message returned to the agent (as a failed write) when the file changed while its review was open. */
export function staleFileMessage(displayPath: string): string {
	return [
		`${displayPath} changed while this change was waiting for review (edited by the user or by another session).`,
		"Nothing was saved. Read the file again and redo the change on its current content.",
	].join(" ");
}

/** What the user wrote when rejecting: per hunk (by index) and for the whole file. */
export interface ReviewNotes {
	hunks: (string | undefined)[];
	file?: string;
}

/** Message returned to the agent (as a failed write) when the user rejected some or all hunks. */
export function rejectionMessage(
	displayPath: string,
	hunks: Hunk[],
	accepted: readonly boolean[],
	notes: ReviewNotes = { hunks: [] },
): string {
	const rejected = hunks.filter((_, i) => !accepted[i]);
	const acceptedCount = hunks.length - rejected.length;
	const noteOn = (hunk: Hunk) => notes.hunks[hunk.index];
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
		for (const hunk of rejected) {
			lines.push("", describeHunk(hunk));
			if (noteOn(hunk)) lines.push(`The user's note on this change: ${noteOn(hunk)}`);
		}
	} else if (noteOn(rejected[0])) {
		lines.push("", `The user's note on this change: ${noteOn(rejected[0])}`);
	}
	if (notes.file) lines.push("", `The user's note on this file: ${notes.file}`);

	if (notes.file || rejected.some(noteOn)) {
		lines.push(
			"",
			"Do what the user's notes ask: they say what to do instead of the rejected changes. Do not re-apply the rejected changes as they were.",
		);
	} else {
		lines.push(
			"",
			"The user does not want the rejected changes and gave no further explanation. Do not ask why and do not re-apply them or try an alternative to them.",
		);
	}
	lines.push("Continue with the rest of the task. Read the file again before editing it further.");
	return lines.join("\n");
}
