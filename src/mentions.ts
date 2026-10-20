/**
 * `@path` mentions in a message: the input suggests the workspace's files and folders as one is
 * typed, and each mentioned path that exists is attached when the message is sent (a folder as a
 * reference, for omp to look in itself).
 */

export interface MentionItem {
	/** As omp is given it: relative to the folder omp runs in when inside it. */
	path: string;
	folder: boolean;
}

/** Punctuation a sentence may put right after a mention: "see @src/a.ts, then…". */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * The paths mentioned in a message, each as the spellings to try in order (as typed, then without
 * trailing punctuation). A mention starts the message or follows a space, so an address like
 * a@b.com is none; `@"a b/c.ts"` mentions a path with spaces (its closing quote may be left off at
 * the end of a line, as picking a folder leaves it). Code (```blocks``` and `spans`) mentions
 * nothing: pasted CSS's @media or a @Test decorator is no path.
 */
export function mentionsIn(text: string): string[][] {
	const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
	const mentions: string[][] = [];
	for (const match of prose.matchAll(/(?:^|\s)@(?:"([^"\n]+)(")?|([^\s"]+))/g)) {
		if (match[1] !== undefined) {
			mentions.push(match[2] ? [match[1]] : unclosedSpellings(match[1]));
			continue;
		}
		const typed = match[3];
		const trimmed = typed.replace(TRAILING_PUNCTUATION, "");
		mentions.push(trimmed && trimmed !== typed ? [typed, trimmed] : [typed]);
	}
	return mentions;
}

/**
 * An unclosed quote runs to the end of its line, which may hold more than the path: picking a folder
 * leaves its quote open, and words typed after it follow (`@"my dir/ what is in here?`). The spellings
 * to try: the whole, then cut back at each space, longest first, each also without trailing punctuation.
 */
function unclosedSpellings(text: string): string[] {
	const spellings: string[] = [];
	const add = (candidate: string) => {
		for (const spelling of [candidate, candidate.replace(TRAILING_PUNCTUATION, "")]) {
			if (spelling && !spellings.includes(spelling)) spellings.push(spelling);
		}
	};
	add(text.trimEnd());
	for (let at = text.length - 1; at > 0; at--) {
		if (/\s/.test(text[at]) && !/\s/.test(text[at - 1])) add(text.slice(0, at));
	}
	return spellings;
}

/**
 * The files and folders (every folder that holds one of the files) that best match what is typed
 * after "@": the name first (exact, then its start, then anywhere), then the path, then its letters
 * in order. With nothing typed yet, the top-level folders and files.
 */
export function rankMentions(files: readonly string[], query: string, limit = 12): MentionItem[] {
	const items: MentionItem[] = [];
	const folders = new Set<string>();
	for (const file of files) {
		// A repository inside the project ("vendor/lib/": untracked as git lists it, or a submodule, see
		// gitStagePaths) is a folder, found below.
		if (!file.endsWith("/")) items.push({ path: file, folder: false });
		for (let slash = file.indexOf("/"); slash > 0; slash = file.indexOf("/", slash + 1)) folders.add(file.slice(0, slash));
	}
	for (const folder of folders) items.push({ path: folder, folder: true });

	const typed = query.toLowerCase().replace(/^\.\//, "").replace(/\/$/, "");
	const scored: { item: MentionItem; score: number }[] = [];
	for (const item of items) {
		const score = typed ? matchScore(item.path.toLowerCase(), typed) : item.path.includes("/") ? undefined : item.folder ? 0 : 1;
		if (score !== undefined) scored.push({ item, score });
	}
	scored.sort((a, b) => a.score - b.score || a.item.path.length - b.item.path.length || a.item.path.localeCompare(b.item.path));
	return scored.slice(0, limit).map(entry => entry.item);
}

/**
 * The paths in `git ls-files --stage -z` output ("<mode> <object> <stage>\t<path>" each), a
 * submodule's (mode 160000, listed like a file) with a trailing slash, so it is taken for a folder.
 */
export function gitStagePaths(output: string): string[] {
	const paths: string[] = [];
	for (const entry of output.split("\0")) {
		const tab = entry.indexOf("\t");
		if (tab < 0) continue;
		const path = entry.slice(tab + 1);
		paths.push(entry.startsWith("160000 ") ? `${path}/` : path);
	}
	return paths;
}

function matchScore(path: string, typed: string): number | undefined {
	const name = path.slice(path.lastIndexOf("/") + 1);
	if (name === typed) return 0;
	if (name.startsWith(typed)) return 1;
	if (name.includes(typed)) return 2;
	if (path.startsWith(typed)) return 3;
	if (path.includes(typed)) return 4;
	let at = 0;
	for (const letter of typed) {
		at = path.indexOf(letter, at) + 1;
		if (at === 0) return undefined;
	}
	return 5;
}

/**
 * What is typed after "@", split at its last slash: the folder typed so far (with its slash, as
 * typed, "" for none) and the start of a name in it. `src/om` is "om" in "src/".
 */
export function splitMentionQuery(query: string): { folder: string; name: string } {
	const slash = query.lastIndexOf("/");
	return { folder: query.slice(0, slash + 1), name: query.slice(slash + 1) };
}

/** Left out of a folder's suggestions until their names are typed. */
const NOISE = new Set(["node_modules"]);

/**
 * A folder's entries that complete the name typed in it, as a shell would: names that start with
 * it first, then names that hold it, folders before files. Paths keep the folder as typed. Hidden
 * entries (".git") show only once a name starting with "." is typed.
 */
export function completeInFolder(
	entries: readonly { name: string; folder: boolean }[],
	folder: string,
	name: string,
	limit = 12,
): MentionItem[] {
	const typed = name.toLowerCase();
	const scored: { name: string; folder: boolean; score: number }[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith(".") && !typed.startsWith(".")) continue;
		if (NOISE.has(entry.name) && !typed) continue;
		const lower = entry.name.toLowerCase();
		const score = lower.startsWith(typed) ? 0 : lower.includes(typed) ? 1 : undefined;
		if (score !== undefined) scored.push({ ...entry, score });
	}
	scored.sort((a, b) => a.score - b.score || Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
	return scored.slice(0, limit).map(entry => ({ path: folder + entry.name, folder: entry.folder }));
}
