/**
 * Splits a proposed file change into hunks (one per contiguous block of changed lines)
 * and rebuilds the file from whichever hunks the user accepts.
 */
import { diffArrays } from "diff";

export interface Hunk {
	index: number;
	/** 0-based first line of this hunk in the original text. */
	oldStart: number;
	oldLines: string[];
	/** 0-based first line of this hunk in the proposed text. */
	newStart: number;
	newLines: string[];
}

type Segment = { kind: "same"; lines: string[] } | { kind: "hunk"; hunk: Hunk };

export interface FileDiff {
	hunks: Hunk[];
	segments: Segment[];
}

/** Split keeping line endings, so joining the pieces reproduces the text exactly. */
export function splitLines(text: string): string[] {
	return text.length === 0 ? [] : text.split(/(?<=\n)/);
}

export function diffFile(original: string, proposed: string): FileDiff {
	const changes = diffArrays(splitLines(original), splitLines(proposed));
	const hunks: Hunk[] = [];
	const segments: Segment[] = [];
	let oldLine = 0;
	let newLine = 0;
	let open: Hunk | undefined;

	for (const change of changes) {
		const lines = change.value as string[];
		if (!change.added && !change.removed) {
			open = undefined;
			segments.push({ kind: "same", lines });
			oldLine += lines.length;
			newLine += lines.length;
			continue;
		}
		if (!open) {
			open = { index: hunks.length, oldStart: oldLine, oldLines: [], newStart: newLine, newLines: [] };
			hunks.push(open);
			segments.push({ kind: "hunk", hunk: open });
		}
		if (change.removed) {
			open.oldLines.push(...lines);
			oldLine += lines.length;
		} else {
			open.newLines.push(...lines);
			newLine += lines.length;
		}
	}
	return { hunks, segments };
}

/** Rebuild the file: accepted hunks take the proposed lines, the rest keep the original lines. */
export function applyDecisions(diff: FileDiff, accepted: readonly boolean[]): string {
	let out = "";
	for (const segment of diff.segments) {
		if (segment.kind === "same") out += segment.lines.join("");
		else out += (accepted[segment.hunk.index] ? segment.hunk.newLines : segment.hunk.oldLines).join("");
	}
	return out;
}

const PREVIEW_LINES = 6;

/** Short +/- rendering of a hunk for messages back to the agent. */
export function describeHunk(hunk: Hunk): string {
	const first = hunk.oldStart + 1;
	const where =
		hunk.oldLines.length === 0
			? `insertion after original line ${hunk.oldStart}`
			: `original lines ${first}-${hunk.oldStart + hunk.oldLines.length}`;
	const render = (prefix: string, lines: string[]) => {
		const shown = lines.slice(0, PREVIEW_LINES).map(line => `${prefix}${line.replace(/\r?\n$/, "")}`);
		if (lines.length > PREVIEW_LINES) shown.push(`${prefix}… (${lines.length - PREVIEW_LINES} more lines)`);
		return shown;
	};
	return [`@@ ${where}`, ...render("-", hunk.oldLines), ...render("+", hunk.newLines)].join("\n");
}
