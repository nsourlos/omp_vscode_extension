// What an attached file is sent to omp as (src/attachments.ts).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
	attachedChipOf,
	chipOf,
	decodeText,
	imageMimeType,
	isChipThumbnail,
	prepareAttachment,
	promptBlocks,
	removeStaleCopies,
	textTokenBudget,
	wrapAttachment,
	DEFAULT_TEXT_TOKEN_BUDGET,
	MAX_IMAGE_BYTES,
	MAX_TEXT_BYTES,
} = require("../dist/core.js");

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const bytesOf = text => new TextEncoder().encode(text);

test("images are told by their first bytes, not their name", () => {
	assert.equal(imageMimeType(PNG), "image/png");
	assert.equal(imageMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(imageMimeType(bytesOf("GIF89a")), "image/gif");
	assert.equal(imageMimeType(bytesOf("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
	assert.equal(imageMimeType(bytesOf("RIFF\0\0\0\0WAVEfmt ")), undefined, "a WAV is RIFF too, but no image");
	assert.equal(imageMimeType(bytesOf("<svg></svg>")), undefined, "an SVG is text");
});

test("text is UTF-8 without NUL characters; anything else is binary", () => {
	assert.equal(decodeText(bytesOf("héllo")), "héllo");
	assert.equal(decodeText(Uint8Array.from([0xef, 0xbb, 0xbf, 0x61])), "a", "a leading BOM is dropped");
	assert.equal(decodeText(Uint8Array.from([0xc3, 0x28])), undefined, "invalid UTF-8");
	assert.equal(decodeText(bytesOf("PK\0\u0003")), undefined, "a NUL byte");
	assert.equal(decodeText(new Uint8Array()), "", "an empty file is empty text");
});

test("a message may attach text up to half the context omp has left, or the setting's amount", () => {
	assert.equal(textTokenBudget(undefined), DEFAULT_TEXT_TOKEN_BUDGET, "before omp has reported its context");
	assert.equal(textTokenBudget({ used: 100_000, size: 1_000_000 }), 450_000);
	assert.equal(textTokenBudget({ used: 210_000, size: 200_000 }), 0, "never below nothing");
	assert.equal(textTokenBudget({ used: 0, size: 1_000_000 }, 5_000), 5_000, "the setting wins when set");
});

test("a text file within the budget goes as its text; over it, as its path", () => {
	const text = prepareAttachment("a1", { name: "a.ts", path: "src/a.ts", bytes: bytesOf("x".repeat(400)) }, 100);
	assert.deepEqual(text, { id: "a1", kind: "text", name: "a.ts", path: "src/a.ts", text: "x".repeat(400), tokens: 100 });
	const big = prepareAttachment("a2", { name: "a.ts", path: "src/a.ts", bytes: bytesOf("x".repeat(404)) }, 100);
	assert.equal(big.kind, "path");
	assert.match(big.reason, /too large to include \(about 101 tokens\)/);
	const pasted = prepareAttachment("a3", { name: "notes.txt", bytes: bytesOf("x".repeat(404)) }, 100);
	assert.match(pasted.error, /notes\.txt can't be attached: it is too large .* location is unknown/);
});

test("an open editor's text is attached as it is, unsaved changes included", () => {
	const attachment = prepareAttachment("a1", { name: "a.ts", path: "a.ts", text: "unsaved", bytes: PNG }, 100);
	assert.equal(attachment.kind, "text");
	assert.equal(attachment.text, "unsaved");
});

test("text over 5 MB goes as its path whatever the budget", () => {
	const attachment = prepareAttachment("a1", { name: "big.log", path: "big.log", bytes: bytesOf("x".repeat(MAX_TEXT_BYTES + 1)) }, Infinity);
	assert.equal(attachment.kind, "path");
});

test("an image goes as an image, a huge one as its path", () => {
	const image = prepareAttachment("a1", { name: "shot.png", path: "docs/shot.png", bytes: PNG }, 0);
	assert.equal(image.kind, "image", "images don't count against the text budget");
	assert.equal(image.mimeType, "image/png");
	assert.equal(image.data, Buffer.from(PNG).toString("base64"));
	const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
	huge.set(PNG);
	const tooLarge = prepareAttachment("a2", { name: "huge.png", path: "huge.png", bytes: huge }, 0);
	assert.equal(tooLarge.kind, "path");
	assert.match(tooLarge.reason, /an image too large to attach \(20\.0 MB\)/);
});

test("folders, binary files and files too large to read go as their paths", () => {
	assert.deepEqual(prepareAttachment("a1", { name: "src", path: "src", folder: true }, 100), { id: "a1", kind: "path", name: "src", path: "src", reason: "a folder" });
	assert.equal(prepareAttachment("a2", { name: "a.zip", path: "a.zip", bytes: bytesOf("PK\0\u0003") }, 100).reason, "not a text file or an image");
	assert.equal(prepareAttachment("a3", { name: "db.bin", path: "db.bin", size: 50 * 1024 * 1024 }, 100).reason, "too large (50.0 MB)");
	const pasted = prepareAttachment("a4", { name: "a.zip", bytes: bytesOf("PK\0\u0003") }, 100);
	assert.match(pasted.error, /a\.zip can't be attached: it is not a text file or an image, and its location is unknown/);
	assert.equal(pasted.needsPath, true, "saved to disk, it could go as a path");
	assert.equal(prepareAttachment("a5", { name: "src", folder: true }, 100).needsPath, true);
});

test("Word, Excel, PowerPoint, PDF and EPUB files go as documents for omp's read tool to turn into text", () => {
	const kinds = ["plan.docx", "Hours 2026.XLSX", "deck.pptx", "paper.pdf", "book.epub"].map(name => {
		const attachment = prepareAttachment("a1", { name, path: `docs/${name}`, bytes: bytesOf("%PDF-1.4 plain ascii") }, 100);
		return [attachment.kind, attachment.reason];
	});
	assert.deepEqual(kinds, [
		["document", "a Word document"],
		["document", "an Excel workbook"],
		["document", "a PowerPoint presentation"],
		["document", "a PDF"],
		["document", "an EPUB book"],
	], "a PDF that happens to be plain ASCII is still a document, not text");
	assert.equal(prepareAttachment("a2", { name: "big.pdf", path: "big.pdf", size: 90 * 1024 * 1024 }, 100).kind, "document", "omp reads it from disk, whatever its size");
	assert.equal(prepareAttachment("a3", { name: "notes.docx", path: "notes.docx", text: "open as text" }, 100).kind, "text", "an editor's text wins");
	const dropped = prepareAttachment("a4", { name: "WBSO Urenregistratie 2026.xlsx", bytes: bytesOf("PK") }, 100);
	assert.equal(dropped.needsPath, true, "dropped from Finder: it needs a copy on disk");
	assert.equal(
		wrapAttachment({ id: "1", kind: "document", name: "plan.docx", path: "/tmp/a1/plan.docx", reason: "a Word document" }),
		'<attached-file path="/tmp/a1/plan.docx" type="document">\nA Word document: its text is not included here. Read it with your read tool, which converts it to text, before you answer.\n</attached-file>',
	);
	const chip = chipOf({ id: "1", kind: "document", name: "plan.docx", path: "/tmp/a1/plan.docx", reason: "a Word document", savedCopy: true });
	assert.match(chip.note, /reads it with its read tool, which turns a Word document into text\.\nIt has no file of its own .* a copy is saved for omp until this chat closes/);
});

test("the prompt is the typed text, then each file's wrapper, then the images in the same order", () => {
	const attachments = [
		{ id: "1", kind: "image", name: "a.png", path: "a.png", data: "AAA", mimeType: "image/png" },
		{ id: "2", kind: "text", name: "b.ts", path: "src/b.ts", text: "const b = 1;" },
		{ id: "3", kind: "image", name: "image.png", data: "BBB", mimeType: "image/jpeg" },
		{ id: "4", kind: "path", name: "big.log", path: "/tmp/big.log", reason: "too large (9.0 MB)" },
	];
	assert.deepEqual(promptBlocks("/review look at these", attachments), [
		{ type: "text", text: "/review look at these" },
		{ type: "text", text: '<attached-file path="a.png" type="image">\nThe image is attached to this message.\n</attached-file>' },
		{ type: "text", text: '<attached-file path="src/b.ts">\nconst b = 1;\n</attached-file>' },
		{ type: "text", text: '<attached-file name="image.png" type="image">\nThe image is attached to this message.\n</attached-file>' },
		{ type: "text", text: '<attached-file path="/tmp/big.log" type="path">\nOnly the path is attached: it is too large (9.0 MB). Read it from disk if you need it.\n</attached-file>' },
		{ type: "image", data: "AAA", mimeType: "image/png" },
		{ type: "image", data: "BBB", mimeType: "image/jpeg" },
	]);
	assert.deepEqual(promptBlocks("hi", []), [{ type: "text", text: "hi" }]);
	assert.equal(promptBlocks("", attachments.slice(1, 2))[0].text.startsWith("<attached-file"), true, "no empty text block");
});

test("a file's own last newline ends its text, with no blank line before the closing tag", () => {
	const wrap = text => wrapAttachment({ id: "1", kind: "text", name: "a", path: "a", text });
	assert.equal(wrap("one\n"), '<attached-file path="a">\none\n</attached-file>');
	assert.equal(wrap("one"), '<attached-file path="a">\none\n</attached-file>');
	assert.equal(wrap(""), '<attached-file path="a">\n</attached-file>');
});

test("a path with quotes or angle brackets can't break out of the wrapper", () => {
	const text = wrapAttachment({ id: "1", kind: "text", name: 'a">b', path: 'dir/a">b<c&', text: "x" });
	assert.equal(text.split("\n")[0], '<attached-file path="dir/a&quot;&gt;b&lt;c&amp;">');
});

test("a chip says how its file is sent, and an image carries the page's small thumbnail, never the whole image", () => {
	const image = { id: "1", kind: "image", name: "a.png", path: "a.png", data: "AAA", mimeType: "image/png" };
	assert.deepEqual(chipOf(image), { id: "1", kind: "image", name: "a.png", path: "a.png", note: "Sent as an image." }, "no thumbnail made yet: the chip shows an icon");
	assert.equal(chipOf({ ...image, thumbnail: "data:image/png;base64,SMALL" }).thumbnail, "data:image/png;base64,SMALL");
	assert.match(chipOf({ id: "3", kind: "path", name: "src", path: "src", reason: "a folder" }).note, /Only its path is sent: it is a folder/);
	assert.match(chipOf({ id: "4", kind: "text", name: "a.ts", text: "x", tokens: 12_345 }).note, /about 12k tokens/);
});

test("a just-attached image shows whole in the input, for the page to make its thumbnail from", () => {
	const image = { id: "1", kind: "image", name: "a.png", data: "AAA", mimeType: "image/png" };
	assert.equal(attachedChipOf(image).thumbnail, "data:image/png;base64,AAA");
	const big = "A".repeat(4 * 1024 * 1024); // a large Retina screenshot: sent once, never kept in the page's history
	assert.equal(attachedChipOf({ ...image, data: big }).thumbnail, `data:image/png;base64,${big}`);
	assert.equal(attachedChipOf({ id: "2", kind: "text", name: "a.ts", text: "x" }).thumbnail, undefined);
});

test("only a small PNG from the page is kept as a thumbnail", () => {
	assert.equal(isChipThumbnail("data:image/png;base64,iVBORw0KGgo="), true);
	assert.equal(isChipThumbnail("data:image/svg+xml;base64,PHN2Zz4="), false, "only the PNG the page's canvas makes");
	assert.equal(isChipThumbnail(`data:image/png;base64,${"A".repeat(70 * 1024)}`), false, "far larger than a thumbnail");
	assert.equal(isChipThumbnail("data:image/png;base64,AA\"><script>"), false);
	assert.equal(isChipThumbnail(undefined), false);
});

test("copies left by a window that is gone are removed; a running window's are kept", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-copies-test-"));
	const child = spawn(process.execPath, ["-e", ""]);
	await new Promise(resolve => child.on("exit", resolve));
	for (const name of [`${child.pid}-1`, `${process.pid}-2`, "notes"]) fs.mkdirSync(path.join(root, name, "a1"), { recursive: true });
	await removeStaleCopies(root);
	assert.deepEqual(fs.readdirSync(root).sort(), [`${process.pid}-2`, "notes"].sort());
	fs.rmSync(root, { recursive: true, force: true });
	await removeStaleCopies(path.join(root, "missing")); // nothing was ever copied: no error
});
