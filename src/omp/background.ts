/**
 * Follows what omp does outside the turns the extension asks for (see sessionLog.ts): after each
 * turn it catches up with the chat's file, and while a background job runs or omp runs a turn of
 * its own, it reads the file every second.
 */
import { findSessionFile, SessionFileReader, SessionTracker, type BackgroundState } from "./sessionLog";

export interface BackgroundHandlers {
	/** What omp does in the background changed. */
	changed(state: BackgroundState): void;
	/** omp finished a turn of its own: its entries in the file. */
	ownTurn(entries: any[]): void;
	log(line: string): void;
}

const POLL_MS = 1000;
const SEARCH_EVERY_MS = 10_000;

export class BackgroundWatch {
	#reader: SessionFileReader | undefined;
	#tracker = new SessionTracker();
	#timer: ReturnType<typeof setInterval> | undefined;
	#reading: Promise<void> = Promise.resolve();
	#reported = JSON.stringify({ jobs: [], continuing: false });
	#disposed = false;
	/** Entries after the latest reply of a turn asked for, not known yet to be part of it (see #read). */
	#held: any[] = [];
	/** When the file was last looked for, while not found. */
	#searchedAt = 0;
	/** Entries from before this omp started are an earlier run's: its jobs ended with it. */
	readonly #since = Date.now();

	constructor(
		readonly sessionId: string,
		private readonly handlers: BackgroundHandlers,
		/** Where omp keeps its files; by default as omp finds it (PI_CODING_AGENT_DIR, else ~/.omp/agent). */
		private readonly agentDir?: string,
		private readonly pollMs = POLL_MS,
	) {}

	/** omp's file of the chat was found, so its background work can be followed. */
	get following(): boolean {
		return this.#reader !== undefined;
	}

	/**
	 * omp works in the background in a way messages wait for, as far as its file tells: a command or helper
	 * agent runs, or a turn of its own. A process (often a server, running for hours) doesn't count.
	 */
	get busy(): boolean {
		return this.#tracker.continuing || [...this.#tracker.jobs.values()].some(job => job.kind !== "process");
	}

	/** Anything runs in the background, so the file is read every second to see it end. */
	get #watching(): boolean {
		return this.#tracker.jobs.size > 0 || this.#tracker.continuing;
	}

	/** omp runs a turn of its own (a background job reported back), so it takes no message now. */
	get continuing(): boolean {
		return this.#tracker.continuing;
	}

	get state(): BackgroundState {
		return { jobs: [...this.#tracker.jobs.values()], continuing: this.#tracker.continuing };
	}

	/** A turn the extension asked for has ended: catch up with the file, and follow it while work goes on in the background. */
	turnEnded(): Promise<void> {
		return this.#read(true);
	}

	/** Catch up with the file now, e.g. before a message is sent: omp may have just started work of its own. */
	refresh(): Promise<void> {
		return this.#read();
	}

	/**
	 * omp asked the user something (an approval, a question, a file to review) while no turn of the user's
	 * ran: it is working on its own, woken by something not followed here. Its file says so already (omp
	 * writes the reply that calls the tool before running it), and is then read until that work ends.
	 */
	ownWorkSeen(): Promise<void> {
		this.#searchedAt = 0; // looked for at once, if not found yet
		return this.#read();
	}

	#read(turnEnded = false): Promise<void> {
		this.#reading = this.#reading.then(async () => {
			if (this.#disposed) return;
			try {
				if (!this.#reader) {
					// Read from its start, whenever it is found: omp writes a message there as soon as it is
					// sent, and what this omp wrote must all be read. An earlier run's entries are left out (#since).
					// Looked for after every turn, and before a message at most every SEARCH_EVERY_MS (it goes through every project's folder).
					if (!turnEnded && Date.now() - this.#searchedAt < SEARCH_EVERY_MS) return;
					this.#searchedAt = Date.now();
					const path = await findSessionFile(this.sessionId, this.agentDir);
					if (!path) return;
					this.#reader = new SessionFileReader(path);
				}
				const entries = (await this.#reader.readNew()).filter(entry => !(Date.parse(entry?.timestamp) < this.#since));
				if (this.#disposed) return;
				// Within a turn asked for, what follows its latest reply waits for the next: until then it isn't known
				// whether the turn goes on (a tool's result) or has ended (a job's result, starting a turn of omp's own).
				const ownTurns: any[][] = [];
				for (const entry of entries) {
					if (!this.#tracker.asking) {
						ownTurns.push(...this.#tracker.apply([entry]));
						continue;
					}
					this.#held.push(entry);
					if (entry?.type === "message" && entry.message?.role === "assistant") ownTurns.push(...this.#tracker.apply(this.#held.splice(0)));
				}
				if (turnEnded) {
					// It has ended, and omp writes each entry as it happens: what followed its last reply came after it.
					this.#tracker.askedTurnEnded();
					ownTurns.push(...this.#tracker.apply(this.#held.splice(0)));
				}
				for (const turn of ownTurns) this.handlers.ownTurn(turn);
			} catch (error) {
				this.handlers.log(`reading omp's file of the chat failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			this.#report();
		});
		// A read that fails in an unforeseen way must not stop every later one (each waits on this chain).
		this.#reading = this.#reading.catch(error => this.handlers.log(`following omp's file of the chat failed: ${error instanceof Error ? error.message : String(error)}`));
		return this.#reading;
	}

	#report(): void {
		if (this.#disposed) return;
		if (this.#tracker.expire(Date.now())) this.handlers.log("a background job is long past its deadline with no result seen: taken to be over");
		if (this.#tracker.endSilentTurn(Date.now())) this.handlers.log("omp wrote nothing after a background job's result for 3 minutes: taken not to be carrying on");
		if (this.#tracker.dropEnded(processRuns)) this.handlers.log("a background process no longer runs, though omp's file didn't say so: taken to be over");
		const state = this.state;
		const key = JSON.stringify(state);
		if (key !== this.#reported) {
			this.#reported = key;
			this.handlers.changed(state);
		}
		if (this.#watching && !this.#timer) this.#timer = setInterval(() => void this.#read(), this.pollMs);
		else if (!this.#watching && this.#timer) this.#stopTimer();
	}

	#stopTimer(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.#stopTimer();
	}
}

/** A process with this id runs on this machine (one of another user's counts too: it exists). */
function processRuns(pid: number): boolean {
	try {
		process.kill(pid, 0); // signal 0 only checks
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
