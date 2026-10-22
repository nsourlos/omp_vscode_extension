// OMP chat panel. Everything from the agent is inserted as text, except replies, which are rendered
// as markdown and sanitised (dist/markdown.js) before they reach the page.
(function () {
	const vscode = acquireVsCodeApi();
	const log = document.getElementById("log");
	const input = document.getElementById("input");
	const sendButton = document.getElementById("send");
	const stopButton = document.getElementById("stop");
	const statusEl = document.getElementById("status");
	const usageEl = document.getElementById("usage");
	const settingsEl = document.getElementById("settings");
	const activityEl = document.getElementById("activity");
	const queueEl = document.getElementById("queue");
	const attachmentsEl = document.getElementById("attachments");
	const attachButton = document.getElementById("attach");

	const KIND_ICONS = {
		read: "📄", edit: "✏️", delete: "🗑️", move: "↔️", search: "🔍",
		execute: "▶", think: "💭", fetch: "🌐", switch_mode: "🔀", other: "⚙️",
	};
	const STATUS_ICONS = { pending: "◌", in_progress: "⏳", completed: "✓", failed: "✗" };
	const MAX_OUTPUT = 6000;

	let assistant = null; // { el, text }
	// A user message omp is replaying from a saved chat: { node, raw, images, messageId }. A chunk with
	// another messageId starts the next message.
	let replayedUser = null;
	let thought = null; // { el, pre }
	let drafts = []; // chips of the files attached in the input, not sent yet
	let planEl = null;
	let commands = [];
	const tools = new Map();
	const requests = new Map();
	const reviews = new Map();

	// What omp is doing right now, shown above the input while a turn runs.
	let busySince = 0;
	let activityTimer = 0;
	let doing = "Working…";
	const runningTools = new Map(); // toolCallId -> title
	const waitingCards = new Set();
	const waitingReviews = new Set();

	// ---------- helpers ----------
	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	function nearBottom() {
		return log.scrollHeight - log.scrollTop - log.clientHeight < 80;
	}

	function append(node) {
		const stick = nearBottom();
		log.appendChild(node);
		if (stick) log.scrollTop = log.scrollHeight;
		return node;
	}

	function keepScrolled(fn) {
		const stick = nearBottom();
		fn();
		if (stick) log.scrollTop = log.scrollHeight;
	}

	function breakFlow() {
		assistant = null;
		thought = null;
		replayedUser = null;
	}

	// GitHub-style markdown (tables, lists, code, links), sanitised by the bundled renderer (dist/markdown.js).
	function renderMarkdown(container, text) {
		container.innerHTML = ompMarkdown.toHtml(text);
		for (const pre of container.querySelectorAll("pre")) addCopyButton(pre);
	}

	function addCopyButton(pre) {
		const button = pre.appendChild(el("button", "copy secondary", "Copy"));
		button.title = "Copy this code";
		button.addEventListener("click", () => {
			const code = pre.querySelector("code")?.textContent ?? pre.textContent;
			navigator.clipboard.writeText(code).then(
				() => (button.textContent = "Copied"),
				// The clipboard API needs the page focused; the older copy command works without it.
				() => (button.textContent = copyWithCommand(code) ? "Copied" : "Copy failed"),
			);
		});
	}

	function copyWithCommand(text) {
		const area = document.body.appendChild(el("textarea"));
		area.value = text;
		area.select();
		const copied = document.execCommand("copy");
		area.remove();
		return copied;
	}

	function textOf(blocks) {
		if (!Array.isArray(blocks)) return "";
		return blocks
			.map(block => {
				if (block?.type === "text") return block.text;
				if (block?.type === "content" && block.content?.type === "text") return block.content.text;
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}

	// Long messages of the user's show their first lines until opened. One observer measures them all
	// again whenever a text's box changes size, e.g. when a hidden tab is shown (it measures nothing while hidden).
	const userTextSizes =
		typeof ResizeObserver === "function"
			? new ResizeObserver(entries => {
					for (const entry of entries) {
						const node = entry.target.closest(".msg.user");
						if (node) fitUserText(node);
					}
				})
			: null;

	/** One of the user's messages, with its attachments and an edit button that puts its text back in the input. */
	function userMessage(text, attachments = []) {
		const node = el("div", "msg user");
		const body = node.appendChild(el("div", "user-text clamped", text));
		// Its label comes from the stylesheet (Show more / Show less), so it adds no text to the message.
		const more = node.appendChild(el("button", "more"));
		more.hidden = true;
		more.setAttribute("aria-label", "Show the whole message");
		more.addEventListener("click", () => {
			const clamped = body.classList.toggle("clamped");
			more.setAttribute("aria-label", clamped ? "Show the whole message" : "Show less of the message");
		});
		userTextSizes?.observe(body);
		node.appendChild(el("div", "attachments"));
		const edit = node.appendChild(el("button", "edit secondary"));
		edit.title = "Edit: put this message back in the input to change and send again";
		edit.setAttribute("aria-label", "Edit this message");
		edit.addEventListener("click", () => restoreInput(body.textContent));
		showAttachments(node, attachments);
		return node;
	}

	/** Show the Show more button only when the clamped text is cut off; an opened message stays open. */
	function fitUserText(node) {
		const body = node.querySelector(".user-text");
		const more = node.querySelector("button.more");
		if (!body || !more || !body.classList.contains("clamped")) return; // e.g. turned into an image's description
		more.hidden = body.scrollHeight <= body.clientHeight + 1;
	}

	// ---------- attachments ----------
	const ATTACHMENT_ICONS = { image: "🖼️", text: "📄", document: "📑", folder: "📁", path: "🔗" };
	const IMAGE_TYPE = /^image\/[\w.+-]+$/;
	/** omp shrinks images to about 500 KB, so a replayed one is small; this keeps a stray huge one off the page. */
	const MAX_THUMBNAIL_CHARS = 3 * 1024 * 1024;

	/** A file attached to a message: its thumbnail or icon and its name; its path and how it is sent show on hover. */
	function attachmentChip(chip, onRemove) {
		const node = el("span", `attachment attachment-${chip.kind}`);
		node.title = [chip.path || chip.name, chip.note].filter(Boolean).join("\n");
		if (typeof chip.thumbnail === "string" && chip.thumbnail.startsWith("data:image/")) {
			const image = node.appendChild(el("img"));
			image.src = chip.thumbnail;
			image.alt = "";
		} else {
			node.appendChild(el("span", "attachment-icon", ATTACHMENT_ICONS[chip.kind] || "📎"));
		}
		node.appendChild(el("span", "attachment-name", chip.name));
		if (onRemove) {
			const remove = node.appendChild(el("button", "secondary", "✕"));
			remove.title = "Remove this file";
			remove.setAttribute("aria-label", `Remove ${chip.name}`);
			remove.addEventListener("click", onRemove);
		}
		return node;
	}

	function showAttachments(message, chips) {
		const files = message.querySelector(".attachments");
		files.textContent = "";
		for (const chip of chips) files.appendChild(attachmentChip(chip));
		files.hidden = chips.length === 0;
	}

	/** An image omp replays from a saved chat, as a chip. */
	function imageChip(content) {
		if (typeof content.data !== "string" || !IMAGE_TYPE.test(content.mimeType || "")) return null;
		const chip = { kind: "image", name: "image" };
		if (content.data.length <= MAX_THUMBNAIL_CHARS) chip.thumbnail = `data:${content.mimeType};base64,${content.data}`;
		return chip;
	}

	/**
	 * A replayed message's own text, and the files the extension attached after it in
	 * <attached-file> wrappers (written by wrapAttachment in src/attachments.ts). A wrapper ends
	 * at a closing tag that ends the message or comes just before the next wrapper, so a file's
	 * text can hold anything else.
	 */
	function splitAttachments(raw) {
		const opening = /<attached-file (path|name)="([^"]*)"(?: type="(image|document|folder|path)")?>\n/y;
		const CLOSE = "\n</attached-file>";
		const NEXT = "\n\n<attached-file ";
		const files = [];
		let start = 0;
		if (!raw.startsWith("<attached-file ")) {
			const found = raw.indexOf(NEXT);
			if (found < 0) return { text: raw, files };
			start = found + 2;
		}
		const end = raw.trimEnd().length;
		let at = start;
		while (at < end) {
			opening.lastIndex = at;
			const match = opening.exec(raw);
			if (!match) break;
			const value = unescapeAttribute(match[2]);
			const path = match[1] === "path" ? value : undefined;
			files.push({ kind: match[3] || "text", name: path ? path.split(/[\\/]/).pop() || path : value, path });
			let next = -1;
			for (let close = raw.indexOf(CLOSE, opening.lastIndex - 1); close >= 0; close = raw.indexOf(CLOSE, close + 1)) {
				const after = close + CLOSE.length;
				if (after >= end) next = end;
				else if (raw.startsWith(NEXT, after)) next = after + 2;
				if (next >= 0) break;
			}
			if (next < 0) break;
			at = next;
		}
		return files.length ? { text: raw.slice(0, start).trimEnd(), files } : { text: raw, files };
	}

	function unescapeAttribute(value) {
		return value.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	}

	/**
	 * omp's description of an attached image, which it gives a model that can't read images (and keeps
	 * hidden in its own app), replayed like a message of the user's.
	 */
	const IMAGE_DESCRIPTION = /^(?:\s*<image path="local:\/\/[^"]*">\n[\s\S]*?\n<\/image>)+\s*$/;

	/** Draw a replayed message again from everything received of it so far; each image goes on its file's chip. */
	function fillReplayed(message) {
		if (!message.images.length && IMAGE_DESCRIPTION.test(message.raw)) {
			const body = message.node.querySelector(".user-text");
			if (body) userTextSizes?.unobserve(body);
			message.node.className = "image-description";
			message.node.textContent = "";
			const details = message.node.appendChild(el("details"));
			details.appendChild(el("summary", "", "omp described the image for the model, which can't read images"));
			const descriptions = [...message.raw.matchAll(/<image path="[^"]*">\n([\s\S]*?)\n<\/image>/g)].map(match => match[1].trim());
			details.appendChild(el("div", "", descriptions.join("\n\n")));
			return;
		}
		if (!message.node.querySelector(".user-text")) {
			// Taken for a description until more of it came: a message of the user's after all.
			const node = userMessage("");
			message.node.replaceWith(node);
			message.node = node;
		}
		const { text, files } = splitAttachments(message.raw);
		message.node.querySelector(".user-text").textContent = text;
		fitUserText(message.node);
		let next = 0;
		const chips = files.map(file => (file.kind === "image" && message.images[next] ? { ...file, thumbnail: message.images[next++].thumbnail } : file));
		chips.push(...message.images.slice(next)); // images with no wrapper, e.g. pasted into omp's terminal app
		showAttachments(message.node, chips);
	}

	function renderDrafts() {
		attachmentsEl.textContent = "";
		for (const chip of drafts) {
			attachmentsEl.appendChild(
				attachmentChip(chip, () => {
					drafts = drafts.filter(draft => draft !== chip);
					vscode.postMessage({ type: "detach", id: chip.id });
					renderDrafts();
				}),
			);
		}
		attachmentsEl.hidden = drafts.length === 0;
	}

	/** Chips are 28 px high (and up to 56 wide): twice that keeps a thumbnail sharp on a high-density screen. */
	const THUMBNAIL_HEIGHT = 56;
	const THUMBNAIL_WIDTH = 112;

	/**
	 * A just-attached image comes whole: make a small copy for its chip and hand it to the extension,
	 * which puts it on the sent or queued message, so the page's history keeps (and replays on every
	 * reload) a few KB instead of the image.
	 */
	function shrinkThumbnail(chip) {
		if (typeof chip.thumbnail !== "string" || !chip.thumbnail.startsWith("data:image/")) return;
		const done = new Promise(resolve => {
			const image = new Image();
			image.onload = () => {
				const scale = Math.min(1, THUMBNAIL_HEIGHT / image.naturalHeight, THUMBNAIL_WIDTH / image.naturalWidth);
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
				canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
				const context = canvas.getContext("2d");
				if (context) {
					context.drawImage(image, 0, 0, canvas.width, canvas.height);
					chip.thumbnail = canvas.toDataURL("image/png");
					if (drafts.includes(chip)) renderDrafts();
					vscode.postMessage({ type: "thumbnail", id: chip.id, data: chip.thumbnail });
				}
				resolve();
			};
			image.onerror = () => resolve();
			image.src = chip.thumbnail;
		});
		pendingThumbnails.set(chip.id, done);
		void done.then(() => pendingThumbnails.delete(chip.id));
	}

	/** Thumbnails still being made, by attachment id: a message waits for its images' (sendWhenThumbnailed). */
	const pendingThumbnails = new Map();
	/** The longest a message waits for them: past that, its chip shows an icon instead. */
	const MAX_THUMBNAIL_WAIT_MS = 1000;
	let waitingSends = null; // messages waiting for thumbnails (and a Stop pressed after them), posted in order

	/** Send the message once its images' thumbnails have reached the extension, so the sent message's chips show them. */
	function sendWhenThumbnailed(message) {
		const pending = message.attachments.map(id => pendingThumbnails.get(id)).filter(Boolean);
		if (pending.length === 0) return afterWaitingSends(message);
		const timeout = new Promise(resolve => setTimeout(resolve, MAX_THUMBNAIL_WAIT_MS));
		afterWaitingSends(message, Promise.race([Promise.all(pending), timeout]));
	}

	/**
	 * Post the message once `ready` resolves, and after any messages still waiting for thumbnails, so
	 * none overtakes another; at once when there is nothing to wait for.
	 */
	function afterWaitingSends(message, ready) {
		if (!waitingSends && !ready) {
			vscode.postMessage(message);
			return;
		}
		const posted = (waitingSends || Promise.resolve()).then(() => ready).then(() => vscode.postMessage(message));
		waitingSends = posted;
		void posted.then(() => {
			if (waitingSends === posted) waitingSends = null;
		});
	}

	/** The largest file the page reads itself (as big as an image may be): its location is unknown, so it can't go as a path. */
	const MAX_PAGE_FILE_BYTES = 20 * 1024 * 1024;

	/** Pasted files, or ones dropped from outside VS Code: read here and handed to the extension. */
	function attachFiles(files) {
		for (const file of files) {
			const name = file.name || "pasted file";
			if (file.size > MAX_PAGE_FILE_BYTES) {
				localNotice("warning", `${name} is too large to attach from here (over 20 MB). Drop it from VS Code's Explorer instead, or attach it with +, so omp gets its path.`);
				continue;
			}
			const reader = new FileReader();
			reader.onload = () => {
				const url = String(reader.result);
				vscode.postMessage({ type: "attachData", name, data: url.slice(url.indexOf(",") + 1) });
			};
			reader.onerror = () => localNotice("warning", `Could not read ${name} (a folder can only be attached from VS Code's Explorer).`);
			reader.readAsDataURL(file);
		}
	}

	function localNotice(level, text) {
		breakFlow();
		append(el("div", `notice ${level}`, text));
	}

	function duration(seconds) {
		if (seconds < 60) return `${seconds}s`;
		return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	}

	function truncate(text) {
		return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + `\n… (${text.length - MAX_OUTPUT} more characters)` : text;
	}

	// Re-rendering a long reply on every chunk is quadratic, so render at most once per frame.
	let pendingRender = null;
	let frame = 0;

	function renderSoon(target) {
		if (pendingRender && pendingRender !== target) flushRender();
		pendingRender = target;
		if (!frame) frame = requestAnimationFrame(flushRender);
	}

	function flushRender() {
		cancelAnimationFrame(frame);
		frame = 0;
		const target = pendingRender;
		pendingRender = null;
		if (target) keepScrolled(() => renderMarkdown(target.el, target.text));
	}

	// ---------- activity line ----------
	function activityText() {
		if (waitingCards.size) return "Waiting for your answer";
		if (waitingReviews.size) return "Waiting for your review";
		if (runningTools.size) return "Running: " + [...runningTools.values()].at(-1);
		return doing;
	}

	function showActivity() {
		if (!busySince) return;
		const seconds = Math.floor((Date.now() - busySince) / 1000);
		const text = `${activityText()} · ${seconds}s`;
		if (activityEl.textContent !== text) activityEl.textContent = text; // called on every streamed chunk and tool update
	}

	function setDoing(text) {
		doing = text;
		showActivity();
	}

	function startActivity() {
		if (busySince) return;
		busySince = Date.now();
		doing = "Working…";
		runningTools.clear();
		waitingCards.clear();
		waitingReviews.clear();
		activityEl.hidden = false;
		activityTimer = setInterval(showActivity, 1000);
		showActivity();
	}

	function stopActivity() {
		busySince = 0;
		clearInterval(activityTimer);
		activityEl.hidden = true;
	}

	// ---------- finish chime ----------
	// opencode's desktop "task finished" sound, loaded ahead of time (only while omp.soundOnFinish is on)
	// so a finished turn plays it straight away. A chime is dropped rather than played late: if the sound
	// has not loaded yet, or the page is one nobody has typed in or clicked yet (e.g. one just moved to a
	// new window), where the browser refuses at once.
	let soundOn = false;
	let chimeSound = null;
	// Set once the sound has loaded, and kept: readyState is no use here, as it drops once a play ends.
	let chimeLoaded = false;

	function setSound(on) {
		soundOn = on;
		if (!on) dropSound();
		else if (!chimeSound) loadSound();
	}

	function loadSound() {
		const src = document.body.dataset.chime;
		if (!src) return; // e.g. a test page
		const sound = (chimeSound = new Audio(src));
		sound.addEventListener("canplaythrough", () => {
			if (chimeSound === sound) chimeLoaded = true;
		}, { once: true });
		sound.addEventListener("error", () => {
			if (chimeSound !== sound) return; // already dropped
			console.warn("OMP: could not load the finish chime", sound.error);
			chimeSound = null; // the next chime loads it again
			chimeLoaded = false;
		});
	}

	/** Stop the sound, including a load still running. */
	function dropSound() {
		if (chimeSound) {
			chimeSound.pause();
			chimeSound.removeAttribute("src");
			chimeSound.load();
		}
		chimeSound = null;
		chimeLoaded = false;
	}

	function chime() {
		if (!chimeLoaded) {
			if (soundOn && !chimeSound) loadSound(); // the last load failed: this chime is skipped, the next one plays
			return;
		}
		chimeSound.currentTime = 0;
		chimeSound.play().catch(error => {
			// Refused on an unused page, or cut short (e.g. the page was hidden or reloaded mid-play): nothing went wrong.
			if (error.name !== "NotAllowedError" && error.name !== "AbortError") console.warn("OMP: could not play the finish chime", error);
		});
	}

	// ---------- context window ----------
	// omp compacts the conversation by itself when the context fills up, but doesn't tell the editor,
	// so a sharp drop in the context used between turns is reported as a compaction.
	const CONTEXT_WARNING_PERCENT = 80;
	let lastContextUsed = 0;
	let warnedContextFull = false;

	function onContextUsage(used, size) {
		const percent = Math.round((used / size) * 100);
		if (lastContextUsed && used < lastContextUsed * 0.6) {
			breakFlow();
			append(el("div", "notice info", `omp compacted the conversation to fit its context window (now ${percent}% full).`));
		} else if (percent >= CONTEXT_WARNING_PERCENT && !warnedContextFull) {
			breakFlow();
			append(el("div", "notice warning", `Context ${percent}% full. omp compacts the conversation by itself when it has to; type /compact to do it now.`));
		}
		warnedContextFull = percent >= CONTEXT_WARNING_PERCENT;
		lastContextUsed = used;
	}

	// A new omp process opens a new session (or reloads a saved one): its context is not compared with the last one's.
	function forgetContextUsage() {
		lastContextUsed = 0;
		warnedContextFull = false;
	}

	// ---------- agent output ----------
	function onUpdate(update) {
		switch (update.sessionUpdate) {
			case "user_message_chunk": {
				// Only sent when a saved chat is loaded: omp replays the conversation so far, a text or image block at a time.
				const text = update.content?.type === "text" ? update.content.text : "";
				const image = update.content?.type === "image" ? imageChip(update.content) : null;
				if (!text && !image) return;
				assistant = null;
				thought = null;
				// Two messages in a row (the same rule as the stored history).
				if (replayedUser && update.messageId !== replayedUser.messageId) replayedUser = null;
				if (!replayedUser) {
					planEl = null;
					replayedUser = { node: append(userMessage("")), raw: "", images: [], messageId: update.messageId };
				}
				if (image) replayedUser.images.push(image);
				else replayedUser.raw += text;
				const message = replayedUser;
				keepScrolled(() => fillReplayed(message));
				return;
			}
			case "agent_message_chunk": {
				const text = update.content?.type === "text" ? update.content.text : "";
				if (!text) return;
				thought = null;
				replayedUser = null;
				setDoing("Writing…");
				if (!assistant) {
					const node = append(el("div", "msg assistant"));
					assistant = { el: node, text: "" };
				}
				assistant.text += text;
				renderSoon(assistant);
				return;
			}
			case "agent_thought_chunk": {
				const text = update.content?.type === "text" ? update.content.text : "";
				if (!text) return;
				replayedUser = null;
				setDoing("Thinking…");
				if (!thought) {
					assistant = null;
					const details = append(el("details", "thought"));
					details.appendChild(el("summary", "", "Thinking"));
					const pre = details.appendChild(el("pre"));
					thought = { el: details, pre };
				}
				keepScrolled(() => (thought.pre.textContent += text));
				return;
			}
			case "tool_call":
			case "tool_call_update":
				return onToolCall(update);
			case "plan":
				return onPlan(update.entries || []);
			case "usage_update": {
				const parts = [];
				if (update.used && update.size) parts.push(`${Math.round((update.used / update.size) * 100)}% context`);
				if (update.cost?.amount !== undefined) parts.push(`$${update.cost.amount.toFixed(3)}`);
				usageEl.textContent = parts.join(" · ");
				if (update.used && update.size) onContextUsage(update.used, update.size);
				return;
			}
			case "available_commands_update":
				commands = update.availableCommands || [];
				return;
		}
	}

	function onToolCall(update) {
		let tool = tools.get(update.toolCallId);
		if (!tool) {
			breakFlow();
			const card = append(el("div", "tool"));
			const head = card.appendChild(el("div", "tool-head"));
			const status = head.appendChild(el("span", "tool-status"));
			const icon = head.appendChild(el("span", "tool-icon"));
			const title = head.appendChild(el("span", "tool-title"));
			const command = card.appendChild(el("pre", "tool-command"));
			command.hidden = true;
			const details = card.appendChild(el("details", "tool-output"));
			details.hidden = true;
			details.appendChild(el("summary", "", "Output"));
			const output = details.appendChild(el("pre"));
			tool = { card, status, icon, title, command, details, output, kind: "other" };
			tools.set(update.toolCallId, tool);
		}
		keepScrolled(() => {
			if (update.kind) tool.kind = update.kind;
			tool.icon.textContent = KIND_ICONS[tool.kind] || KIND_ICONS.other;
			if (update.title) tool.title.textContent = update.title;
			if (update.status) {
				tool.status.textContent = STATUS_ICONS[update.status] || "";
				tool.card.dataset.status = update.status;
			}
			if (tool.card.dataset.status === "completed" || tool.card.dataset.status === "failed") {
				notRunning(update.toolCallId);
			} else {
				runningTools.set(update.toolCallId, tool.title.textContent || "a tool");
			}
			showActivity();
			const command = update.rawInput?.command;
			if (typeof command === "string") {
				tool.command.textContent = "$ " + command;
				tool.command.hidden = false;
			}
			// A shell tool's title is its command, already shown in the command box: show it once.
			tool.title.hidden = !tool.command.hidden && isCommandTitle(tool.title.textContent, tool.command.textContent.slice(2));
			const diff = update.rawOutput?.details?.diff;
			const text = typeof diff === "string" && diff ? diff : textOf(update.rawOutput?.content) || textOf(update.content);
			if (text && update.sessionUpdate === "tool_call_update") {
				tool.output.textContent = truncate(text);
				tool.details.hidden = false;
				if (update.status === "failed") tool.details.open = true;
			}
		});
	}

	/** omp titles a shell call "$ <command>", cut to 4000 characters with "…". */
	function isCommandTitle(title, command) {
		const text = title.trim().replace(/^\$\s+/, "");
		command = command.trim();
		if (text === command) return true;
		return text.endsWith("…") && text.length > 1 && command.startsWith(text.slice(0, -1));
	}

	function onPlan(entries) {
		if (!planEl) {
			breakFlow();
			planEl = append(el("div", "plan"));
		}
		keepScrolled(() => {
			planEl.textContent = "";
			planEl.appendChild(el("div", "heading", "Plan"));
			const list = planEl.appendChild(el("ul"));
			for (const entry of entries) {
				const mark = entry.status === "completed" ? "☑" : entry.status === "in_progress" ? "◐" : "☐";
				list.appendChild(el("li", `plan-${entry.status}`, `${mark} ${entry.content}`));
			}
		});
	}

	// ---------- cards that wait for the user ----------
	function respond(requestId, value, label, extra = {}) {
		vscode.postMessage({ type: "respond", requestId, value, label, ...extra });
		markResolved(requestId, label);
	}

	function markResolved(requestId, label) {
		if (waitingCards.delete(requestId)) showActivity();
		const card = requests.get(requestId);
		if (!card) return;
		card.classList.add("resolved");
		for (const button of card.querySelectorAll("button, input, textarea, select")) button.disabled = true;
		const result = card.querySelector(".card-result");
		if (result) result.textContent = label;
	}

	function card(requestId, heading) {
		breakFlow();
		const node = append(el("div", "card"));
		node.appendChild(el("div", "card-heading", heading));
		requests.set(requestId, node);
		waitingCards.add(requestId);
		showActivity();
		return node;
	}

	function addWarning(node, warning) {
		if (warning) node.appendChild(el("div", "warning", "⚠ " + warning));
	}

	function finishCard(node) {
		node.appendChild(el("div", "card-result"));
		node.scrollIntoView({ block: "nearest" });
	}

	const OPTION_HINTS = {
		allow_always: "Allow this kind of action for the rest of this chat",
		reject_always: "Reject this kind of action for the rest of this chat",
	};

	// The question goes inside the tool's own row (omp gives both the same toolCallId), so the
	// command is shown once; afterwards the same row shows ✓ / ✗ and the output.
	function onPermission(msg) {
		const isCommand = typeof msg.command === "string";
		let id = msg.toolCallId;
		if (!id || !tools.has(id)) {
			id = id || `permission-${msg.requestId}`;
			onToolCall({ toolCallId: id, title: msg.title, kind: msg.kind, status: "pending", rawInput: isCommand ? { command: msg.command } : undefined });
			if (!msg.toolCallId) runningTools.delete(id); // no tool updates will follow for a made-up row
		}
		const tool = tools.get(id);
		breakFlow();
		const node = tool.card.insertBefore(el("div", "tool-ask"), tool.details);
		node.appendChild(el("div", "card-heading", isCommand ? "Run this command?" : "Allow this?"));
		requests.set(msg.requestId, node);
		waitingCards.add(msg.requestId);
		showActivity();
		if (msg.cwd) node.appendChild(el("div", "location", `in folder: ${msg.cwd}`));
		for (const path of msg.locations || []) node.appendChild(el("div", "location", path));
		addWarning(node, msg.warning);
		let readOnlyBox = null;
		const toAllow = Array.isArray(msg.offerReadOnly) ? msg.offerReadOnly.join(", ") : "";
		if (toAllow) {
			// Not a button: this command is not read-only, so it still needs its own answer.
			const label = node.appendChild(el("label", "choice always-read-only"));
			readOnlyBox = label.appendChild(el("input"));
			readOnlyBox.type = "checkbox";
			label.appendChild(document.createTextNode(` From now on, allow ${toAllow} without asking in this chat`));
			label.title = `Later commands made only of these programs run without asking, when they only read. Anything else, this command included, still asks.`;
		}
		const buttons = node.appendChild(el("div", "buttons"));
		for (const option of msg.options || []) {
			const button = buttons.appendChild(el("button", option.kind.startsWith("allow") ? "" : "secondary", option.name));
			const hint = option.description || OPTION_HINTS[option.kind];
			if (hint) button.title = hint;
			button.addEventListener("click", () => {
				if (readOnlyBox?.checked) respond(msg.requestId, option.optionId, `${option.name} · ${toAllow} allowed from now on`, { allowReadOnly: true });
				else respond(msg.requestId, option.optionId, option.name);
				if (!option.kind.startsWith("allow")) notRunning(id); // a rejected tool never runs, and omp may not say so
			});
		}
		const reject = (msg.options || []).find(option => option.kind === "reject_once");
		if (reject) addRejectWithNote(node, buttons, msg, reject, id, readOnlyBox);
		finishCard(node);
	}

	/**
	 * "Reject with note…": a note for omp and, for a command, the command to change. The extension
	 * stops the turn and sends them as the next message, since omp's answer can only say "rejected".
	 */
	function addRejectWithNote(node, buttons, msg, reject, toolCallId, readOnlyBox) {
		const open = buttons.appendChild(el("button", "secondary", "Reject with note…"));
		open.title = "Reject, and tell omp what to do instead, or change the command";
		const form = node.appendChild(el("div", "reject-note"));
		form.hidden = true;
		let commandBox = null;
		if (typeof msg.command === "string") {
			form.appendChild(el("div", "field-description", "Change the command to suggest another (omp still asks before running it):"));
			commandBox = form.appendChild(el("textarea", "reject-command"));
			commandBox.value = msg.command;
			commandBox.rows = Math.min(6, Math.max(2, Math.ceil(msg.command.length / 70)));
		}
		form.appendChild(el("div", "field-description", "Note for omp:"));
		const note = form.appendChild(el("textarea"));
		note.rows = 2;
		note.placeholder = "What should omp do instead?";
		const actions = form.appendChild(el("div", "buttons"));
		const submit = actions.appendChild(el("button", "", "Reject and send"));
		const cancel = actions.appendChild(el("button", "secondary", "Cancel"));
		open.addEventListener("click", () => {
			form.hidden = false;
			buttons.hidden = true;
			note.focus();
		});
		cancel.addEventListener("click", () => {
			form.hidden = true;
			buttons.hidden = false;
		});
		const send = () => {
			const text = note.value.trim();
			const changed = commandBox && commandBox.value.trim() !== msg.command.trim() ? commandBox.value.trim() : "";
			if (!text && !changed) {
				note.focus(); // nothing to send: Reject does that
				return;
			}
			// The checkbox counts whatever the answer, as with the other buttons.
			const allowed = readOnlyBox?.checked ? { allowReadOnly: true } : {};
			const label = changed ? "Rejected with a changed command" : "Rejected with a note";
			respond(msg.requestId, reject.optionId, readOnlyBox?.checked ? `${label} · ${msg.offerReadOnly.join(", ")} allowed from now on` : label, {
				note: text,
				changedCommand: changed || undefined,
				...allowed,
			});
			notRunning(toolCallId);
		};
		submit.addEventListener("click", send);
		note.addEventListener("keydown", event => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
		});
	}

	function notRunning(toolCallId) {
		if (runningTools.delete(toolCallId) && !runningTools.size) doing = "Working…";
		showActivity();
	}

	function onAutoAllowed(msg) {
		const tool = tools.get(msg.toolCallId);
		const names = Array.isArray(msg.names) && msg.names.length ? msg.names.join(", ") : "read-only commands";
		if (tool) tool.card.insertBefore(el("div", "tool-note", `Allowed automatically: you always allow ${names} in this chat`), tool.details);
	}

	function onApproval(msg) {
		const browser = msg.toolName === "browser";
		const node = card(msg.requestId, browser ? "Allow omp to use the browser?" : `Allow tool: ${msg.toolName}?`);
		if (msg.details) node.appendChild(el("pre", "tool-command", msg.details));
		if (msg.urls?.length) {
			node.appendChild(el("div", "field-description", "Addresses written in the code:"));
			for (const url of msg.urls) node.appendChild(el("div", "location", "🌐 " + url));
		}
		if (browser) node.appendChild(el("div", "field-description", browserNote(msg)));
		// Shown open and in full: the listed addresses are read from the code, which can never
		// reveal every page it opens, so the code itself is what the user approves.
		if (msg.code) {
			const code = node.appendChild(el("details", "tool-output approval-code"));
			code.open = true;
			code.appendChild(el("summary", "", "Code it will run"));
			code.appendChild(el("pre", "", msg.code));
		}
		addWarning(node, msg.warning);
		const buttons = node.appendChild(el("div", "buttons"));
		buttons.appendChild(el("button", "", "Approve")).addEventListener("click", () => respond(msg.requestId, "Approve", "Approved"));
		buttons.appendChild(el("button", "secondary", "Deny")).addEventListener("click", () => respond(msg.requestId, "Deny", "Denied"));
		finishCard(node);
	}

	function browserNote(msg) {
		if (msg.code) {
			if (msg.someUrlsHidden) return "Some addresses are built from variables, so they are not listed. Check the code below for every page it may open.";
			if (msg.urls?.length) return "The code may also open pages not listed here. Check it below.";
			return "No address is written in the code. Check it below for the page it opens.";
		}
		if (msg.unclear) return "Several code steps that use the browser are running, so it is unclear which page this is for.";
		return "omp did not say which page.";
	}

	// Generic form for omp questions (select / confirm / input / multi-question ask).
	function onQuestion(msg) {
		const node = card(msg.requestId, msg.message || "omp has a question");
		const properties = msg.schema?.properties || {};
		const readers = [];
		for (const [key, prop] of Object.entries(properties)) {
			const field = node.appendChild(el("div", "field"));
			if (prop.title && prop.title !== msg.message) field.appendChild(el("div", "field-title", prop.title));
			if (prop.description) field.appendChild(el("div", "field-description", prop.description));
			const choices = prop.enum ? prop.enum.map(v => ({ const: v, title: v })) : prop.oneOf;
			const multi = prop.type === "array" ? prop.items?.anyOf || [] : null;
			if (choices) {
				const name = `${msg.requestId}-${key}`;
				for (const choice of choices) {
					const label = field.appendChild(el("label", "choice"));
					const radio = label.appendChild(el("input"));
					radio.type = "radio";
					radio.name = name;
					radio.value = choice.const;
					radio.checked = prop.default === choice.const;
					label.appendChild(document.createTextNode(" " + (choice.title || choice.const)));
					if (choice.description) label.appendChild(el("span", "field-description", " — " + choice.description));
				}
				readers.push(() => {
					const picked = field.querySelector("input:checked");
					return picked ? [key, picked.value] : null;
				});
			} else if (multi) {
				for (const choice of multi) {
					const label = field.appendChild(el("label", "choice"));
					const box = label.appendChild(el("input"));
					box.type = "checkbox";
					box.value = choice.const;
					label.appendChild(document.createTextNode(" " + (choice.title || choice.const)));
				}
				readers.push(() => [key, [...field.querySelectorAll("input:checked")].map(b => b.value)]);
			} else if (prop.type === "boolean") {
				const label = field.appendChild(el("label", "choice"));
				const box = label.appendChild(el("input"));
				box.type = "checkbox";
				box.checked = prop.default === true;
				label.appendChild(document.createTextNode(" Yes"));
				readers.push(() => [key, box.checked]);
			} else {
				const area = field.appendChild(el("textarea"));
				area.rows = 2;
				if (typeof prop.default === "string") area.value = prop.default;
				readers.push(() => (area.value.trim() ? [key, area.value] : null));
			}
		}
		const buttons = node.appendChild(el("div", "buttons"));
		buttons.appendChild(el("button", "", "Submit")).addEventListener("click", () => {
			const content = {};
			for (const read of readers) {
				const entry = read();
				if (entry) content[entry[0]] = entry[1];
			}
			respond(msg.requestId, content, "Answered");
		});
		buttons.appendChild(el("button", "secondary", "Skip")).addEventListener("click", () => respond(msg.requestId, undefined, "Skipped"));
		finishCard(node);
	}

	function onReview(info) {
		let node = reviews.get(info.id);
		if (!node) {
			breakFlow();
			node = append(el("div", "card review"));
			reviews.set(info.id, node);
		}
		node.textContent = "";
		if (info.state === "done") waitingReviews.delete(info.id);
		else waitingReviews.add(info.id);
		showActivity();
		const count = `${info.hunkCount} change${info.hunkCount === 1 ? "" : "s"}`;
		if (info.state === "done") {
			node.classList.add("resolved");
			node.appendChild(el("div", "card-heading", `✏️ ${info.displayPath}: ${info.summary}`));
			return;
		}
		node.appendChild(el("div", "card-heading", `✏️ Review ${count} to ${info.displayPath}`));
		node.appendChild(
			el("div", "field-description", info.state === "queued" ? "Waiting for the previous review." : "Accept or reject each change in the diff editor."),
		);
		const button = node.appendChild(el("button", "", "Open diff"));
		button.addEventListener("click", () => vscode.postMessage({ type: "openReview", reviewId: info.id }));
	}

	function onConfig(options) {
		settingsEl.textContent = "";
		for (const option of options || []) {
			const select = settingsEl.appendChild(el("select"));
			select.title = option.name;
			for (const choice of option.options || []) {
				const opt = select.appendChild(el("option", "", choice.name));
				opt.value = choice.value;
				if (choice.description) opt.title = choice.description;
			}
			select.value = option.currentValue;
			select.addEventListener("change", () =>
				vscode.postMessage({ type: "setConfig", configId: option.id, value: select.value }),
			);
		}
	}

	// Messages sent while omp works wait here until the turn ends.
	function onQueued(msg) {
		const item = queueEl.appendChild(el("div", "queued"));
		item.dataset.id = msg.id;
		item.appendChild(el("span", "queued-label", "Queued"));
		item.appendChild(el("span", "queued-text", msg.text));
		const files = msg.attachments || [];
		if (files.length) {
			const names = item.appendChild(el("span", "queued-files", `📎 ${files.map(file => file.name).join(", ")}`));
			names.title = files.map(file => file.path || file.name).join("\n");
		}
		const remove = item.appendChild(el("button", "secondary", "✕"));
		remove.title = "Remove from the queue";
		remove.addEventListener("click", () => vscode.postMessage({ type: "unqueue", id: msg.id }));
	}

	function onDequeued(ids) {
		for (const item of [...queueEl.children]) if (ids.includes(item.dataset.id)) item.remove();
	}

	/** Put text (and its attachments) back in the input, ahead of what is there. */
	function restoreInput(text, attachments = []) {
		if (text) input.value = input.value.trim() ? `${text}\n\n${input.value}` : text;
		if (attachments.length) {
			drafts = [...attachments, ...drafts];
			renderDrafts();
		}
		input.focus();
	}

	function setStatus(state) {
		const labels = { starting: "Starting omp…", busy: "Working…", naming: "Naming the chat…", idle: "Ready", stopped: "Stopped" };
		statusEl.textContent = labels[state] || state;
		if (state === "starting") forgetContextUsage();
		statusEl.dataset.state = state;
		// A message can be what starts omp, and Stop must still work while it starts.
		stopButton.hidden = !(state === "busy" || state === "naming" || (state === "starting" && busySince));
		if (state === "busy") startActivity();
		else if (state !== "starting") stopActivity();
	}

	window.addEventListener("message", event => {
		const msg = event.data;
		switch (msg.type) {
			case "user":
				breakFlow();
				planEl = null;
				fitUserText(append(userMessage(msg.text, msg.attachments)));
				return;
			case "attached":
				drafts.push(msg.attachment);
				renderDrafts();
				shrinkThumbnail(msg.attachment);
				return;
			case "update": return onUpdate(msg.update);
			case "permission": return onPermission(msg);
			case "autoAllowed": return onAutoAllowed(msg);
			case "approval": return onApproval(msg);
			case "question": return onQuestion(msg);
			case "resolved": return markResolved(msg.requestId, msg.label);
			case "review": return onReview(msg.info);
			case "config": return onConfig(msg.options);
			case "status": return setStatus(msg.state);
			case "sound": return setSound(msg.on);
			case "chime": return chime();
			case "queued": return onQueued(msg);
			case "dequeued": return onDequeued(msg.ids);
			case "restoreInput": return restoreInput(msg.text, msg.attachments);
			case "mentions": return onMentions(msg);
			case "notice":
				breakFlow();
				append(el("div", `notice ${msg.level || "info"}`, msg.text));
				return;
			case "turnEnd":
				flushRender(); // a page in the background gets no frames: draw the finished reply now
				breakFlow();
				if (msg.stopReason && msg.stopReason !== "end_turn") append(el("div", "notice warning", `Stopped: ${msg.stopReason}`));
				if (typeof msg.seconds === "number") {
					const meta = msg.model ? `${msg.model} · ${duration(msg.seconds)}` : duration(msg.seconds);
					append(el("div", "reply-meta", meta));
				}
				return;
		}
	});

	// ---------- input ----------
	const suggestions = el("div", "suggestions");
	suggestions.hidden = true;
	input.parentElement.insertBefore(suggestions, input);

	// Suggestions under the input: slash commands, and files and folders after "@". Picked with a
	// click, or the arrow keys and Enter or Tab; Escape closes them.
	let suggestionItems = []; // { row, pick }
	let activeSuggestion = -1;
	let mentionRequest = 0;
	let mentionTimer = 0;

	function updateSuggestions() {
		const mention = mentionAtCursor();
		clearTimeout(mentionTimer);
		mentionRequest++; // results for what was typed before are dropped
		if (mention) {
			// The rows shown are for what was typed before: nothing is picked until the new ones arrive, so Enter sends as typed.
			activeSuggestion = -1;
			markActiveSuggestion();
			const id = mentionRequest;
			mentionTimer = setTimeout(() => vscode.postMessage({ type: "findMentions", id, query: mention.query }), 60);
			return;
		}
		const match = /^\/(\S*)$/.exec(input.value);
		const hits = match ? commands.filter(c => c.name.startsWith(match[1])).slice(0, 8) : [];
		// No row is picked until an arrow key moves to it, so Enter still sends "/compact" as typed.
		showSuggestions(
			hits.map(command => ({
				render: row => {
					row.appendChild(el("strong", "", "/" + command.name));
					row.appendChild(document.createTextNode(" " + (command.description || "")));
				},
				pick: () => (input.value = "/" + command.name + " "),
			})),
			-1,
		);
	}

	/** The "@…" being typed at the cursor, if any: where it starts, and what is typed after "@". */
	function mentionAtCursor() {
		if (input.selectionStart !== input.selectionEnd) return null;
		const before = input.value.slice(0, input.selectionStart);
		const match = /(^|\s)@("[^"\n]*|[^\s"]*)$/.exec(before);
		if (!match) return null;
		const quoted = match[2].startsWith('"');
		// The rest of the word the cursor is in (and a quoted mention's closing quote), which a picked path
		// replaces too. Only up to a space: a quoted mention typed before other words must leave them.
		const after = (quoted ? /^[^\s"]*"?/ : /^[^\s"]*/).exec(input.value.slice(input.selectionStart))[0];
		return { start: before.length - match[2].length - 1, end: input.selectionStart + after.length, query: match[2].replace(/^"/, "") };
	}

	function onMentions(msg) {
		const mention = mentionAtCursor();
		if (msg.id !== mentionRequest || !mention) return;
		const items = (msg.items || []).filter(item => typeof item.path === "string" && !item.path.includes('"'));
		// The first row is picked (for Enter or Tab) only when it holds the name being typed: a guess from
		// letters in order (@john → src/json/handler.ts), or a folder typed in full (@src/), sends as typed.
		const name = mention.query.slice(mention.query.lastIndexOf("/") + 1).toLowerCase();
		const active = name && items[0]?.path.toLowerCase().includes(name) ? 0 : -1;
		showSuggestions(
			items.map(item => ({
				render: row => {
					const slash = item.path.lastIndexOf("/");
					row.appendChild(el("span", "suggestion-icon", item.folder ? "📁" : "📄"));
					row.appendChild(el("strong", "", item.path.slice(slash + 1) + (item.folder ? "/" : "")));
					if (slash > 0) row.appendChild(el("span", "suggestion-dir", " " + item.path.slice(0, slash)));
					row.title = item.path;
				},
				pick: () => {
					const at = mentionAtCursor();
					if (!at) return; // the cursor has left the mention: nothing to replace
					// A file ends the mention; a folder stays open (quote and all), so its contents show next.
					const quote = /\s/.test(item.path) ? '"' : "";
					const rest = input.value.slice(at.end);
					const space = /^\s/.test(rest) ? "" : " ";
					const text = item.folder ? `@${quote}${item.path}/` : `@${quote}${item.path}${quote}${space}`;
					input.value = input.value.slice(0, at.start) + text + rest;
					input.selectionStart = input.selectionEnd = at.start + text.length;
				},
			})),
			active,
		);
	}

	function showSuggestions(items, active) {
		suggestions.textContent = "";
		suggestionItems = items.map(item => {
			const row = suggestions.appendChild(el("div", "suggestion"));
			item.render(row);
			row.addEventListener("mousedown", event => {
				event.preventDefault(); // keeps the input focused
				pickSuggestion(item);
			});
			return { row, pick: item.pick };
		});
		activeSuggestion = items.length ? active : -1;
		markActiveSuggestion();
		suggestions.hidden = items.length === 0;
	}

	function markActiveSuggestion() {
		suggestionItems.forEach(({ row }, i) => row.classList.toggle("active", i === activeSuggestion));
		suggestionItems[activeSuggestion]?.row.scrollIntoView({ block: "nearest" });
	}

	function pickSuggestion(item) {
		item.pick();
		input.focus();
		updateSuggestions();
	}

	function hideSuggestions() {
		clearTimeout(mentionTimer);
		mentionRequest++;
		showSuggestions([], -1);
	}

	/** Arrow keys, Enter, Tab and Escape while suggestions show; true when the key was used. */
	function suggestionKey(event) {
		if (suggestions.hidden || suggestionItems.length === 0) return false;
		const count = suggestionItems.length;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			const step = event.key === "ArrowDown" ? 1 : -1;
			activeSuggestion = activeSuggestion < 0 ? (step > 0 ? 0 : count - 1) : (activeSuggestion + step + count) % count;
			markActiveSuggestion();
		} else if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && activeSuggestion >= 0) {
			pickSuggestion(suggestionItems[activeSuggestion]);
		} else if (event.key === "Escape") {
			hideSuggestions();
		} else {
			return false;
		}
		event.preventDefault();
		return true;
	}

	/** The text starts with a slash command: one omp listed, or, before it has, any /word (a path has more slashes). */
	function startsWithCommand(text) {
		const match = /^\/([^\s/]+)(?:\s|$)/.exec(text);
		return Boolean(match) && (commands.length === 0 || commands.some(command => command.name === match[1]));
	}

	function send() {
		const text = input.value.trim();
		if (!text && drafts.length === 0) return;
		if (drafts.length > 0 && startsWithCommand(text)) {
			// omp would read the files' text as the command's arguments (/compact's instructions, say).
			localNotice("warning", "A slash command can't take attached files: send the command on its own, and the files in a message of their own.");
			return;
		}
		sendWhenThumbnailed({ type: "send", text, attachments: drafts.map(chip => chip.id) });
		input.value = "";
		drafts = [];
		renderDrafts();
		updateSuggestions();
	}

	attachButton.addEventListener("click", () => vscode.postMessage({ type: "pickFiles" }));

	/**
	 * Excel, Word and Keynote copy a picture of the selection along with its text, as plain and rich
	 * text: the text is what was meant. A file copied in Finder comes with only its name, as plain text.
	 */
	function isRichTextCopy(data) {
		const types = [...(data.types || [])];
		return Boolean(data.getData?.("text/plain")?.trim()) && (types.includes("text/html") || types.includes("text/rtf"));
	}

	input.addEventListener("paste", event => {
		const files = [...(event.clipboardData?.files || [])];
		if (files.length === 0 || isRichTextCopy(event.clipboardData)) return; // text pastes as usual
		event.preventDefault();
		attachFiles(files);
	});

	// Files dropped on the page. VS Code hands a drop to a page in an editor tab only while Shift is held.
	// From the Explorer or a tab the drop carries the files' addresses; from outside VS Code, the files themselves.
	const URI_LIST_TYPES = ["application/vnd.code.uri-list", "text/uri-list"];
	const JSON_LIST_TYPES = ["resourceurls", "codefiles"]; // VS Code's own: addresses, and paths

	function isFileDrag(event) {
		const types = [...(event.dataTransfer?.types || [])].map(type => type.toLowerCase());
		return types.includes("files") || [...URI_LIST_TYPES, ...JSON_LIST_TYPES].some(type => types.includes(type));
	}

	function droppedUris(data) {
		for (const type of URI_LIST_TYPES) {
			const list = data.getData(type);
			if (list) return list.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("#"));
		}
		for (const type of JSON_LIST_TYPES) {
			try {
				const list = JSON.parse(data.getData(type) || "[]");
				if (Array.isArray(list) && list.length) return list.filter(item => typeof item === "string");
			} catch {
				// not a list: try the next kind
			}
		}
		return [];
	}

	let dragDepth = 0; // dragenter/dragleave fire for every element crossed
	function endDrag() {
		dragDepth = 0;
		document.body.classList.remove("dropping");
	}
	document.addEventListener("dragenter", event => {
		if (!isFileDrag(event)) return;
		event.preventDefault();
		dragDepth++;
		document.body.classList.add("dropping");
	});
	document.addEventListener("dragover", event => {
		if (!isFileDrag(event)) return;
		event.preventDefault(); // allows the drop
		event.dataTransfer.dropEffect = "copy";
	});
	document.addEventListener("dragleave", event => {
		if (isFileDrag(event) && --dragDepth <= 0) endDrag();
	});
	document.addEventListener("drop", event => {
		endDrag();
		if (!isFileDrag(event)) return; // dragged text drops into the input as usual
		event.preventDefault();
		const uris = droppedUris(event.dataTransfer);
		if (uris.length) vscode.postMessage({ type: "attachUris", uris });
		else attachFiles([...event.dataTransfer.files]);
		input.focus();
	});

	input.addEventListener("input", updateSuggestions);
	input.addEventListener("blur", hideSuggestions);
	// A cursor moved off (or into) a mention changes what the suggestions are for. Up and Down move in the list instead.
	const CURSOR_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
	input.addEventListener("keyup", event => {
		if (CURSOR_KEYS.has(event.key)) updateSuggestions();
	});
	input.addEventListener("click", updateSuggestions);
	input.addEventListener("keydown", event => {
		if (event.isComposing) return;
		if (suggestionKey(event)) return;
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			send();
		}
	});
	sendButton.addEventListener("click", send);
	// After a message still waiting for its thumbnails: Stop then puts it back in the input, as for any queued message.
	stopButton.addEventListener("click", () => afterWaitingSends({ type: "cancel" }));

	vscode.postMessage({ type: "ready" });
})();
