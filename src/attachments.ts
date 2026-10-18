/**
 * Files attached to a message, and what each one is sent to omp as.
 *
 * omp (ACP) passes image blocks to the model as images (for a model that can't read images, it has
 * one that can describe them), and joins every text block into the prompt's text. It drops a
 * `resource` block's file name, so an attached file goes as a text block wrapped in
 * <attached-file>, which names the file for the model and lets a replayed saved chat show it
 * as a chip again (media/chat.js reads the same format back).
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ContentBlock } from "./acp/types";

export type AttachmentKind = "image" | "text" | "document" | "path";

export interface Attachment {
	id: string;
	kind: AttachmentKind;
	/** The file's name, shown on its chip. */
	name: string;
	/** The path omp is given (relative to the folder when inside it); none for pasted content. */
	path?: string;
	/** What a "document" is ("a Word document"), or why only a "path" attachment's path is sent ("too large (…)"). */
	reason?: string;
	/** The path is of a copy the extension saved, as the file came with no location (pasted, or dropped from outside VS Code). */
	savedCopy?: boolean;
	/** A text attachment's contents. */
	text?: string;
	/** Estimated tokens of a text attachment, counted against the message's budget. */
	tokens?: number;
	/** An image's bytes, base64. */
	data?: string;
	mimeType?: string;
	/** A small copy of an image for its chip, a data: URL the chat page made (see isChipThumbnail). */
	thumbnail?: string;
}

/** What the chat page shows for an attachment. */
export interface AttachmentChip {
	id: string;
	kind: AttachmentKind;
	name: string;
	path?: string;
	/** Shown on hover. */
	note?: string;
	/** A data: URL of the image: a small thumbnail, or the whole image just after it is attached (attachedChipOf). */
	thumbnail?: string;
}

/** A file to attach: read from disk or an open editor, or handed over by the chat page (pasted, or dropped from outside VS Code). */
export interface AttachmentSource {
	name: string;
	path?: string;
	folder?: boolean;
	/** Its size, when it is too large to read (no bytes given). */
	size?: number;
	bytes?: Uint8Array;
	/** An open editor's text, unsaved changes included: used instead of the bytes. */
	text?: string;
}

/** omp refuses images it reads that are larger than this, and shrinks smaller ones itself (to 1568 px, about 500 KB). */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Larger text goes as a path whatever the budget, so the chat page and omp's connection stay quick. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
/** The text budget before omp has said how big its context is: half of a 200k-token context. */
export const DEFAULT_TEXT_TOKEN_BUDGET = 100_000;
/** A thumbnail from the page is a few KB; anything far larger is not one. */
const MAX_THUMBNAIL_CHARS = 64 * 1024;

/** The largest file worth reading: anything bigger can only go as a path. */
export const MAX_READ_BYTES = Math.max(MAX_IMAGE_BYTES, MAX_TEXT_BYTES);

/** The documents omp's read tool converts to text (its CONVERTIBLE_EXTENSIONS), by extension. */
const DOCUMENTS: Record<string, string> = {
	".docx": "a Word document",
	".xlsx": "an Excel workbook",
	".pptx": "a PowerPoint presentation",
	".pdf": "a PDF",
	".epub": "an EPUB book",
};

/** What kind of document omp can turn this file into text from, if any ("a Word document"). */
export function documentKind(name: string): string | undefined {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? undefined : DOCUMENTS[name.slice(dot).toLowerCase()];
}

/** The image formats the models take, by their first bytes (not the file's extension). */
export function imageMimeType(bytes: Uint8Array): string | undefined {
	const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
	return undefined;
}

/** The bytes as text if they are UTF-8 with no NUL character, which binary files nearly always have. */
export function decodeText(bytes: Uint8Array): string | undefined {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); // drops a leading BOM
	} catch {
		return undefined;
	}
	return text.includes("\0") ? undefined : text;
}

/** A rough token count (about 4 characters a token), close enough to keep attached text within the context. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * How many tokens of text one message may attach: `override` when set (above 0), else half of
 * the context omp has left, or a default before omp has said how much that is.
 */
export function textTokenBudget(context: { used: number; size: number } | undefined, override = 0): number {
	if (override > 0) return override;
	if (!context || !(context.size > 0)) return DEFAULT_TEXT_TOKEN_BUDGET;
	return Math.max(0, Math.floor((context.size - context.used) / 2));
}

/**
 * Decide what a file goes to omp as: an image, its text, a document omp's read tool turns into
 * text, or (too large, a folder, or none of these) its path, which omp can read itself. One that
 * needs a path but has none is an error with `needsPath`: saved to disk, it can go after all.
 */
export function prepareAttachment(
	id: string,
	source: AttachmentSource,
	tokensLeft: number,
): Attachment | { error: string; needsPath?: boolean } {
	const { name, path } = source;
	const unreadable = (reason: string) => ({ error: `${name} can't be attached: it is ${reason}, and its location is unknown, so omp can't read it either.`, needsPath: true });
	const asPath = (reason: string): Attachment | { error: string; needsPath?: boolean } =>
		path ? { id, kind: "path", name, path, reason } : unreadable(reason);
	if (source.folder) return asPath("a folder");
	const document = source.text === undefined ? documentKind(name) : undefined;
	if (document) return path ? { id, kind: "document", name, path, reason: document } : unreadable(document);
	if (source.text === undefined && !source.bytes) return asPath(`too large (${megabytes(source.size ?? 0)})`);
	const bytes = source.bytes;
	const mimeType = source.text === undefined && bytes ? imageMimeType(bytes) : undefined;
	if (mimeType && bytes) {
		if (bytes.length > MAX_IMAGE_BYTES) return asPath(`an image too large to attach (${megabytes(bytes.length)})`);
		return { id, kind: "image", name, path, data: Buffer.from(bytes).toString("base64"), mimeType };
	}
	const text = source.text ?? (bytes ? decodeText(bytes) : undefined);
	if (text === undefined) return asPath("not a text file or an image");
	const tokens = estimateTokens(text);
	if (Buffer.byteLength(text) > MAX_TEXT_BYTES || tokens > tokensLeft) return asPath(`too large to include (about ${thousands(tokens)} tokens)`);
	return { id, kind: "text", name, path, text, tokens };
}

/** The chip the chat page shows for an attachment. */
export function chipOf(attachment: Attachment): AttachmentChip {
	const chip: AttachmentChip = { id: attachment.id, kind: attachment.kind, name: attachment.name, path: attachment.path };
	if (attachment.kind === "path") chip.note = `Only its path is sent: it is ${attachment.reason}. omp can read it if it needs to.`;
	if (attachment.kind === "document") chip.note = `omp gets its path and reads it with its read tool, which turns ${attachment.reason} into text.`;
	if (attachment.kind === "text") chip.note = `Its text is sent (about ${thousands(attachment.tokens ?? 0)} tokens).`;
	if (attachment.savedCopy) chip.note += "\nIt has no file of its own (pasted, dropped from outside VS Code, or an unsaved editor), so a copy is saved for omp until this chat closes.";
	if (attachment.kind === "image") {
		chip.note = "Sent as an image.";
		if (attachment.thumbnail) chip.thumbnail = attachment.thumbnail;
	}
	return chip;
}

/**
 * The chip shown in the input as a file is attached: an image shows whole, for the page to make its
 * thumbnail from. Any size (up to MAX_IMAGE_BYTES): this message is posted once, never kept in the page's history.
 */
export function attachedChipOf(attachment: Attachment): AttachmentChip {
	const chip = chipOf(attachment);
	if (attachment.kind === "image" && !chip.thumbnail && attachment.data) {
		chip.thumbnail = `data:${attachment.mimeType};base64,${attachment.data}`;
	}
	return chip;
}

/** A thumbnail the page made (a small PNG data: URL), safe to keep and show on chips. */
export function isChipThumbnail(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_THUMBNAIL_CHARS && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value);
}

/**
 * Remove the copies left by windows that closed without removing them (VS Code crashed, or was killed).
 * `root` holds a folder per chat, named `<window's pid>-<chat id>`: in the extension's own storage,
 * private to this user, unlike a temp folder shared by every user on Linux.
 */
export async function removeStaleCopies(root: string): Promise<void> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return; // nothing was ever copied
	}
	for (const name of names) {
		const pid = Number(/^(\d+)-/.exec(name)?.[1]);
		if (!pid || pid === process.pid || isRunning(pid)) continue;
		await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"; // someone else's process
	}
}

/**
 * The prompt omp is sent: the typed text first (omp reads a slash command only at the very
 * start), then each attachment in its <attached-file> wrapper, then the images. omp joins the
 * text blocks and keeps the images in order, so each image matches its wrapper.
 */
export function promptBlocks(text: string, attachments: readonly Attachment[]): ContentBlock[] {
	const blocks: ContentBlock[] = text ? [{ type: "text", text }] : [];
	for (const attachment of attachments) blocks.push({ type: "text", text: wrapAttachment(attachment) });
	for (const attachment of attachments) {
		if (attachment.kind === "image" && attachment.data && attachment.mimeType) blocks.push({ type: "image", data: attachment.data, mimeType: attachment.mimeType });
	}
	return blocks;
}

/** An attachment as the model reads it, and as a replayed chat shows it (see splitAttachments in media/chat.js). */
export function wrapAttachment(attachment: Attachment): string {
	const where = attachment.path ? `path="${escapeAttribute(attachment.path)}"` : `name="${escapeAttribute(attachment.name)}"`;
	switch (attachment.kind) {
		case "text": {
			const text = attachment.text ?? "";
			return `<attached-file ${where}>\n${text}${text.endsWith("\n") || !text ? "" : "\n"}</attached-file>`;
		}
		case "image":
			return `<attached-file ${where} type="image">\nThe image is attached to this message.\n</attached-file>`;
		case "document": {
			const what = (attachment.reason ?? "a document").replace(/^./, letter => letter.toUpperCase());
			return `<attached-file ${where} type="document">\n${what}: its text is not included here. Read it with your read tool, which converts it to text, before you answer.\n</attached-file>`;
		}
		case "path":
			return `<attached-file ${where} type="path">\nOnly the path is attached: it is ${attachment.reason}. Read it from disk if you need it.\n</attached-file>`;
	}
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function megabytes(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function thousands(tokens: number): string {
	return tokens >= 10_000 ? `${Math.round(tokens / 1000)}k` : tokens.toLocaleString("en-US");
}
