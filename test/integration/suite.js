// Runs inside a real VS Code with the extension loaded, against a real `omp acp`.
// Clicks Accept on the first change of each review and Reject on the rest, like a user would.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const log = (...args) => console.log("[integration]", ...args);
const allTabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);

exports.run = async function run() {
	const extension = vscode.extensions.getExtension("local.omp-vscode");
	assert.ok(extension, "extension is installed in the test VS Code");
	const api = await extension.activate();
	const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "demo.py");

	await vscode.commands.executeCommand("omp.openChat");
	await sleep(1000);
	assert.ok(
		allTabs().some(tab => tab.input instanceof vscode.TabInputWebview && tab.label === "OMP 1"),
		"clicking OMP opens the chat as an editor tab",
	);
	log("chat tab opened");

	const reviews = [];
	api.reviews.onDidChangeReview(async info => {
		reviews.push(info);
		if (info.state !== "open") return;
		await sleep(1500); // give the diff editor time to open
		const diffOpen = allTabs().some(
			tab => tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === "omp-review",
		);
		log(`review of ${info.displayPath}: ${info.hunkCount} change(s), diff editor open: ${diffOpen}`);
		info.diffOpen = diffOpen;
		await vscode.commands.executeCommand("omp.review.acceptHunk", info.id, 0);
		for (let i = 1; i < info.hunkCount; i++) await vscode.commands.executeCommand("omp.review.rejectHunk", info.id, i);
	});

	await api.sessions.active.controller.send(
		"In demo.py make exactly two changes in ONE edit call: change greet to print Hello instead of Hi, " +
			"and add a one-line docstring to add(). Then stop.",
	);

	const text = fs.readFileSync(file, "utf8");
	log(`demo.py after the turn:\n${text}`);
	const opened = reviews.filter(info => info.state === "open");
	const done = reviews.filter(info => info.state === "done");
	log(`reviews: ${done.map(info => `${info.displayPath} ${info.summary}`).join("; ")}`);
	assert.ok(opened.length > 0, "the edit went through the diff review");
	assert.ok(opened.every(info => info.diffOpen), "every review opened in the diff editor");
	assert.equal(done.length, opened.length, "every review finished");
	assert.match(text, /print\("Hello"\)/, "the accepted change was saved");
	assert.ok(!allTabs().some(tab => tab.input instanceof vscode.TabInputTextDiff), "diff tabs closed after review");
	log("edit review: PASS");

	await attachByDropping(api, path.dirname(file));
	log("PASS");
};

const SHIFT = 8; // the DevTools protocol's modifier bit

/**
 * Drop files on the chat the way a user does, through VS Code's real drag and drop (the window's
 * DevTools protocol): one from outside VS Code (as from Finder) and one dragged from the Explorer,
 * both with Shift held, then send them with Enter. The model must answer from both files.
 */
async function attachByDropping(api, root) {
	const port = process.env.OMP_CDP_PORT;
	assert.ok(port, "run.mjs starts this VS Code with a debugging port");
	const note = path.join(root, "drop-note.txt");
	const image = path.join(root, "split.png");
	fs.writeFileSync(note, "The secret word is pineapple.\n");
	fs.writeFileSync(image, splitPng());

	const { panel } = api.sessions.active;
	const notes = record(panel, "notify");
	const posts = record(panel, "post");
	const attached = () => notes.filter(m => m.type === "attached").map(m => m.attachment);
	const win = await connectToWindow(port);
	try {
		panel.reveal();
		await win.page("Page.bringToFront");
		await sleep(500);
		const finderDrop = { items: [], files: [image], dragOperationsMask: 1 };

		await dropOnChat(win, finderDrop, 0);
		await sleep(2000);
		const opened = allTabs().find(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.fsPath === image);
		log(`dropped without Shift: ${attached().length} attached, ${opened ? "VS Code opened the file" : "no tab opened"}`);
		assert.equal(attached().length, 0, "without Shift VS Code keeps the drop, as the README says");
		if (opened) await vscode.window.tabGroups.close(opened);
		panel.reveal();
		await sleep(500);

		await dropOnChat(win, finderDrop, SHIFT);
		await waitFor(() => attached().length === 1, "the image dropped with Shift");
		log(`dropped from outside VS Code with Shift: ${JSON.stringify(withoutThumbnail(attached()[0]))}`);

		const fromExplorer = await dragFromExplorer(win, "drop-note.txt");
		log(`Explorer drag carries: ${fromExplorer.items.map(item => item.mimeType).join(", ")}`);
		const received = record(panel, "receive");
		await dropOnChat(win, fromExplorer, SHIFT);
		await waitFor(() => attached().length === 2, "the file dragged from the Explorer with Shift").catch(error => {
			log(`the page sent: ${JSON.stringify(received)}; notices: ${JSON.stringify(posts.filter(m => m.type === "notice"))}`);
			log(`drag data: ${JSON.stringify(fromExplorer).slice(0, 1500)}`);
			throw error;
		});
		const [png, text] = attached();
		log(`dragged from the Explorer with Shift: ${JSON.stringify(text)}`);
		assert.equal(png.kind, "image");
		assert.deepEqual([text.kind, text.name, text.path], ["text", "drop-note.txt", "drop-note.txt"]);

		// Type the question in the chat and press Enter, as a user would.
		await clickChat(win, 70);
		await win.page("Input.insertText", { text: "What is the secret word in drop-note.txt, and which colours are on the left and right of split.png? Answer in at most twelve words." });
		for (const type of ["keyDown", "keyUp"]) {
			await win.page("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
		}
		const sent = await waitFor(() => posts.find(m => m.type === "user"), "the message to be sent");
		assert.deepEqual(sent.attachments.map(chip => chip.name), [png.name, "drop-note.txt"], "both files went with it");
		await waitFor(() => posts.some(m => m.type === "turnEnd"), "the model's reply", 240_000);
		const reply = posts
			.filter(m => m.type === "update" && m.update.sessionUpdate === "agent_message_chunk")
			.map(m => m.update.content?.text ?? "")
			.join("");
		log(`reply: ${reply.trim()}`);
		assert.match(reply, /pineapple/i, "the model read the text file");
		assert.match(reply, /red/i, "the model saw the image's red half");
		assert.match(reply, /blue/i, "and its blue half");
	} finally {
		win.close();
	}
}

/** Every call of the panel's `post` or `notify` from now on. */
function record(panel, method) {
	const calls = [];
	const original = panel[method].bind(panel);
	panel[method] = message => {
		calls.push(message);
		original(message);
	};
	return calls;
}

function withoutThumbnail(chip) {
	const { thumbnail, ...rest } = chip;
	return { ...rest, thumbnail: thumbnail ? `${thumbnail.slice(0, 22)}…` : undefined };
}

async function waitFor(check, what, timeout = 15_000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await check();
		if (value) return value;
		await sleep(100);
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** The workbench page of this test VS Code, over the DevTools protocol. */
async function connectToWindow(port) {
	const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
	const ws = new WebSocket(webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", reject, { once: true });
	});
	let id = 0;
	const pending = new Map();
	const listeners = new Set();
	ws.addEventListener("message", event => {
		const message = JSON.parse(event.data);
		if (message.id) {
			pending.get(message.id)?.(message);
			pending.delete(message.id);
		} else {
			for (const listener of listeners) listener(message);
		}
	});
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const callId = ++id;
			pending.set(callId, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
			ws.send(JSON.stringify({ id: callId, method, params, sessionId }));
		});
	const { targetInfos } = await send("Target.getTargets");
	const workbench = targetInfos.find(target => target.type === "page" && target.url.includes("workbench"));
	const { sessionId } = await send("Target.attachToTarget", { targetId: workbench.targetId, flatten: true });
	const page = (method, params) => send(method, params, sessionId);
	return {
		page,
		async evaluate(expression) {
			const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, returnByValue: true });
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		},
		/** The next event of this kind from the page. */
		next(method, timeout = 5000) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					listeners.delete(listener);
					reject(new Error(`no ${method} within ${timeout} ms`));
				}, timeout);
				const listener = message => {
					if (message.method !== method || message.sessionId !== sessionId) return;
					clearTimeout(timer);
					listeners.delete(listener);
					resolve(message.params);
				};
				listeners.add(listener);
			});
		},
		close: () => ws.close(),
	};
}

/** A point in the visible chat tab, `fromBottom` pixels above its bottom edge (its input is there). */
function chatPoint(win, fromBottom) {
	return win.evaluate(`(() => {
		const frame = [...document.querySelectorAll("iframe.webview")].find(f => f.getBoundingClientRect().width > 0 && f.checkVisibility({ visibilityProperty: true }));
		const box = frame.getBoundingClientRect();
		return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height - ${fromBottom}) };
	})()`);
}

async function clickChat(win, fromBottom) {
	const { x, y } = await chatPoint(win, fromBottom);
	for (const type of ["mousePressed", "mouseReleased"]) await win.page("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
}

/** Drag `data` over the chat and drop it, holding `modifiers` (SHIFT, or 0). */
async function dropOnChat(win, data, modifiers) {
	const { x, y } = await chatPoint(win, 90);
	for (const type of ["dragEnter", "dragOver", "dragOver", "drop"]) {
		await win.page("Input.dispatchDragEvent", { type, x, y, modifiers, data });
		await sleep(100);
	}
	await win.page("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/**
 * Drag a file's row in the Explorer with Shift held, and return what the drag carries (VS Code's
 * own drag data). A drag that starts in the workbench makes VS Code block every webview from it
 * until it sees the drag move with Shift held, so the drag is moved over the Explorer with Shift
 * first, which is what a user does by pressing Shift before reaching the chat. (A simulated drag
 * stays with the frame it entered first, unlike a real one, so it then enters the chat afresh.)
 */
async function dragFromExplorer(win, name) {
	await vscode.commands.executeCommand("workbench.view.explorer");
	await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
	const row = await waitFor(
		() =>
			win.evaluate(`(() => {
				const row = [...document.querySelectorAll(".explorer-folders-view .monaco-list-row")].find(r => r.textContent.trim() === ${JSON.stringify(name)});
				if (!row) return null;
				const box = row.getBoundingClientRect();
				return { x: Math.round(box.x + 50), y: Math.round(box.y + box.height / 2) };
			})()`),
		`${name} in the Explorer`,
	);
	await win.page("Input.setInterceptDrags", { enabled: true });
	const intercepted = win.next("Input.dragIntercepted");
	await win.page("Input.dispatchMouseEvent", { type: "mousePressed", x: row.x, y: row.y, button: "left", buttons: 1, clickCount: 1 });
	for (let step = 1; step <= 6; step++) {
		await win.page("Input.dispatchMouseEvent", { type: "mouseMoved", x: row.x + step * 25, y: row.y + step * 4, button: "left", buttons: 1 });
	}
	const { data } = await intercepted;
	await win.page("Input.setInterceptDrags", { enabled: false });
	const beside = { x: row.x + 150, y: row.y + 24 };
	await win.page("Input.dispatchMouseEvent", { type: "mouseReleased", ...beside, button: "left", clickCount: 1 });
	const blocked = () => win.evaluate(`[...document.querySelectorAll("iframe.webview")].some(f => f.style.pointerEvents === "none")`);
	assert.ok(await blocked(), "a drag from the Explorer blocks the chat, as VS Code does for every webview");
	for (const type of ["dragEnter", "dragOver"]) await win.page("Input.dispatchDragEvent", { type, ...beside, modifiers: SHIFT, data });
	await waitFor(async () => !(await blocked()), "VS Code to let the chat take the drag once Shift is held");
	await sleep(500); // the window draws the change before the pointer reaches the chat, as it would by hand
	return data;
}

/** A 64×64 PNG, red on the left half and blue on the right. */
function splitPng() {
	const { deflateSync } = require("node:zlib");
	const table = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = bytes => {
		let c = 0xffffffff;
		for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const check = Buffer.alloc(4);
		check.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, check]);
	};
	const size = 64;
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header[8] = 8; // bits per channel
	header[9] = 2; // RGB
	const row = Buffer.from([0, ...Array.from({ length: size }, (_, x) => (x < size / 2 ? [255, 0, 0] : [0, 0, 255])).flat()]);
	const pixels = Buffer.concat(Array.from({ length: size }, () => row));
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
