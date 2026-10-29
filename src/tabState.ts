/**
 * What VS Code keeps for a chat tab across a restart: the page stores it (vscode.setState) and VS Code
 * hands it back to the extension when it restores the tab (Sessions.restore).
 */
export interface TabState {
	/** The tab's name, e.g. "OMP 2". */
	label: string;
	/** The omp chat it shows. */
	sessionId?: string;
	/** The chat's name. */
	title?: string;
	/** Something was sent (or a saved chat was loaded), so omp has a chat to load again. */
	saved: boolean;
	/** A reply was running. */
	busy: boolean;
	/** Messages queued and not sent yet, in order, with the names of their attached files. */
	queued: { id: string; text: string; files: string[] }[];
	/** Typed in the input and not sent, and the names of the files attached there (kept by the page). */
	input?: string;
	inputFiles?: string[];
}

export function newTabState(label: string, sessionId?: string, title?: string): TabState {
	return { label, sessionId, title, saved: sessionId !== undefined, busy: false, queued: [] };
}

/** The tab's state after the extension posts this message to its page. */
export function tabStateAfter(state: TabState, message: any): TabState {
	switch (message?.type) {
		case "user":
			return state.saved ? state : { ...state, saved: true };
		case "status": {
			const busy = message.state === "busy";
			return busy === state.busy ? state : { ...state, busy };
		}
		case "queued":
			return typeof message.text === "string" ? { ...state, queued: [...state.queued, { id: String(message.id), text: message.text, files: names(message.attachments) }] } : state;
		case "dequeued": {
			const ids: unknown[] = Array.isArray(message.ids) ? message.ids : [];
			const queued = state.queued.filter(item => !ids.includes(item.id));
			return queued.length === state.queued.length ? state : { ...state, queued };
		}
		default:
			return state;
	}
}

/** A state VS Code handed back, checked: it comes from the page, so anything in it may be missing or odd. */
export function readTabState(value: unknown): TabState | undefined {
	const state = value as Partial<TabState> | undefined;
	if (!state || typeof state !== "object" || typeof state.label !== "string" || !state.label) return undefined;
	const text = (field: unknown): string | undefined => (typeof field === "string" && field ? field : undefined);
	const queued = Array.isArray(state.queued)
		? state.queued.filter(item => typeof item?.text === "string").map(item => ({ id: String(item.id), text: item.text, files: strings(item.files) }))
		: [];
	return {
		label: state.label,
		sessionId: text(state.sessionId),
		title: text(state.title),
		saved: state.saved === true,
		busy: state.busy === true,
		queued,
		input: text(state.input),
		inputFiles: strings(state.inputFiles),
	};
}

/** The names of chips (attached files), or of a stored list. */
function names(chips: unknown): string[] {
	return Array.isArray(chips) ? chips.map(chip => chip?.name).filter((name): name is string => typeof name === "string" && name !== "") : [];
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item !== "") : [];
}

/** What goes back in a restored tab's input: the queued messages, then what was being typed. */
export function unsentText(state: TabState): string {
	return [...state.queued.map(item => item.text), state.input ?? ""].filter(text => text.trim()).join("\n\n");
}

/** The files attached to what wasn't sent, which a restart can't bring back (only their names were kept). */
export function unsentFiles(state: TabState): string[] {
	return [...state.queued.flatMap(item => item.files), ...(state.inputFiles ?? [])];
}
