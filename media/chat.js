// OMP chat panel. Everything from the agent is inserted as text (never as HTML).
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

	const KIND_ICONS = {
		read: "📄", edit: "✏️", delete: "🗑️", move: "↔️", search: "🔍",
		execute: "▶", think: "💭", fetch: "🌐", switch_mode: "🔀", other: "⚙️",
	};
	const STATUS_ICONS = { pending: "◌", in_progress: "⏳", completed: "✓", failed: "✗" };
	const MAX_OUTPUT = 6000;

	let assistant = null; // { el, text }
	let thought = null; // { el, pre }
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
	}

	function inline(parent, text) {
		const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/);
		for (const part of parts) {
			if (!part) continue;
			if (part.startsWith("`") && part.endsWith("`") && part.length > 1) parent.appendChild(el("code", "", part.slice(1, -1)));
			else if (part.startsWith("**") && part.endsWith("**") && part.length > 3) parent.appendChild(el("strong", "", part.slice(2, -2)));
			else parent.appendChild(document.createTextNode(part));
		}
	}

	// Small, safe markdown subset: code fences, headings, lists, paragraphs, inline code and bold.
	function renderMarkdown(container, text) {
		container.textContent = "";
		const fence = /```[^\n]*\n?([\s\S]*?)(```|$)/g;
		let last = 0;
		let match;
		while ((match = fence.exec(text))) {
			renderBlocks(container, text.slice(last, match.index));
			const pre = el("pre", "code");
			pre.appendChild(el("code", "", match[1].replace(/\n$/, "")));
			container.appendChild(pre);
			last = fence.lastIndex;
			if (match[0].length === 0) break;
		}
		renderBlocks(container, text.slice(last));
	}

	function renderBlocks(container, text) {
		let paragraph = null;
		let list = null;
		for (const line of text.split("\n")) {
			const heading = /^(#{1,6})\s+(.*)$/.exec(line);
			const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
			const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
			if (!line.trim()) {
				paragraph = null;
				list = null;
			} else if (heading) {
				paragraph = null;
				list = null;
				const h = el("div", "heading");
				inline(h, heading[2]);
				container.appendChild(h);
			} else if (bullet || numbered) {
				paragraph = null;
				const tag = bullet ? "ul" : "ol";
				if (!list || list.tagName.toLowerCase() !== tag) {
					list = el(tag);
					container.appendChild(list);
				}
				const li = el("li");
				inline(li, (bullet || numbered)[1]);
				list.appendChild(li);
			} else {
				list = null;
				if (!paragraph) {
					paragraph = el("p");
					container.appendChild(paragraph);
				} else {
					paragraph.appendChild(el("br"));
				}
				inline(paragraph, line);
			}
		}
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

	// ---------- agent output ----------
	function onUpdate(update) {
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const text = update.content?.type === "text" ? update.content.text : "";
				if (!text) return;
				thought = null;
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
				if (runningTools.delete(update.toolCallId) && !runningTools.size) doing = "Working…";
			} else {
				runningTools.set(update.toolCallId, tool.title.textContent || "a tool");
			}
			showActivity();
			const command = update.rawInput?.command;
			if (typeof command === "string") {
				tool.command.textContent = "$ " + command;
				tool.command.hidden = false;
			}
			const diff = update.rawOutput?.details?.diff;
			const text = typeof diff === "string" && diff ? diff : textOf(update.rawOutput?.content) || textOf(update.content);
			if (text && update.sessionUpdate === "tool_call_update") {
				tool.output.textContent = truncate(text);
				tool.details.hidden = false;
				if (update.status === "failed") tool.details.open = true;
			}
		});
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
	function respond(requestId, value, label) {
		vscode.postMessage({ type: "respond", requestId, value, label });
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
		allow_always: "Allow this kind of tool for the rest of the session (for shell commands: every command)",
		reject_always: "Reject this kind of tool for the rest of the session",
	};

	function onPermission(msg) {
		const isCommand = typeof msg.command === "string";
		const node = card(msg.requestId, isCommand ? "Run this command?" : msg.title);
		if (isCommand) node.appendChild(el("pre", "tool-command", "$ " + msg.command));
		for (const path of msg.locations || []) node.appendChild(el("div", "location", path));
		addWarning(node, msg.warning);
		const buttons = node.appendChild(el("div", "buttons"));
		for (const option of msg.options || []) {
			const button = buttons.appendChild(el("button", option.kind.startsWith("allow") ? "" : "secondary", option.name));
			if (OPTION_HINTS[option.kind]) button.title = OPTION_HINTS[option.kind];
			button.addEventListener("click", () => respond(msg.requestId, option.optionId, option.name));
		}
		finishCard(node);
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
		const remove = item.appendChild(el("button", "secondary", "✕"));
		remove.title = "Remove from the queue";
		remove.addEventListener("click", () => vscode.postMessage({ type: "unqueue", id: msg.id }));
	}

	function onDequeued(ids) {
		for (const item of [...queueEl.children]) if (ids.includes(item.dataset.id)) item.remove();
	}

	function restoreInput(text) {
		input.value = input.value.trim() ? `${text}\n\n${input.value}` : text;
		input.focus();
	}

	function setStatus(state) {
		const labels = { starting: "Starting omp…", busy: "Working…", idle: "Ready", stopped: "Stopped" };
		statusEl.textContent = labels[state] || state;
		statusEl.dataset.state = state;
		// A message can be what starts omp, and Stop must still work while it starts.
		stopButton.hidden = !(state === "busy" || (state === "starting" && busySince));
		if (state === "busy") startActivity();
		else if (state !== "starting") stopActivity();
	}

	window.addEventListener("message", event => {
		const msg = event.data;
		switch (msg.type) {
			case "user":
				breakFlow();
				planEl = null;
				append(el("div", "msg user", msg.text));
				return;
			case "update": return onUpdate(msg.update);
			case "permission": return onPermission(msg);
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
			case "restoreInput": return restoreInput(msg.text);
			case "notice":
				breakFlow();
				append(el("div", `notice ${msg.level || "info"}`, msg.text));
				return;
			case "turnEnd":
				breakFlow();
				if (msg.stopReason && msg.stopReason !== "end_turn") append(el("div", "notice warning", `Stopped: ${msg.stopReason}`));
				return;
		}
	});

	// ---------- input ----------
	const suggestions = el("div", "suggestions");
	suggestions.hidden = true;
	input.parentElement.insertBefore(suggestions, input);

	function updateSuggestions() {
		const value = input.value;
		const match = /^\/(\S*)$/.exec(value);
		suggestions.textContent = "";
		if (!match || commands.length === 0) {
			suggestions.hidden = true;
			return;
		}
		const hits = commands.filter(c => c.name.startsWith(match[1])).slice(0, 8);
		for (const command of hits) {
			const row = suggestions.appendChild(el("div", "suggestion"));
			row.appendChild(el("strong", "", "/" + command.name));
			row.appendChild(document.createTextNode(" " + (command.description || "")));
			row.addEventListener("mousedown", event => {
				event.preventDefault();
				input.value = "/" + command.name + " ";
				updateSuggestions();
				input.focus();
			});
		}
		suggestions.hidden = hits.length === 0;
	}

	function send() {
		const text = input.value.trim();
		if (!text) return;
		vscode.postMessage({ type: "send", text });
		input.value = "";
		updateSuggestions();
	}

	input.addEventListener("input", updateSuggestions);
	input.addEventListener("keydown", event => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			send();
		}
	});
	sendButton.addEventListener("click", send);
	stopButton.addEventListener("click", () => vscode.postMessage({ type: "cancel" }));

	vscode.postMessage({ type: "ready" });
})();
