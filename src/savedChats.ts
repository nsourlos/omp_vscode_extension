/** Sorting omp's saved chats for the "Continue a previous chat" list. */
import type { SavedSession } from "./acp/types";

/**
 * Chats continued in another folder than the one omp saved them under, by chat id. omp keeps
 * saving such a chat to its first folder's history, so the extension remembers where it went.
 */
export type ContinuedChats = Record<string, { folder: string }>;

/** The ids of the chats last continued in `folder`. */
export function continuedIn(continued: ContinuedChats, folder: string): Set<string> {
	return new Set(Object.keys(continued).filter(id => continued[id].folder === folder));
}

/** `continued` without the chats omp no longer has, given every chat omp has saved. */
export function forgetDeleted(continued: ContinuedChats, every: SavedSession[]): ContinuedChats {
	const saved = new Set(every.map(chat => chat.sessionId));
	return Object.fromEntries(Object.entries(continued).filter(([id]) => saved.has(id)));
}

/** Each chat once, newest first, leaving out empty ones (there is nothing to continue). */
export function chatsToShow(chats: SavedSession[]): SavedSession[] {
	const seen = new Set<string>();
	const shown = chats.filter(chat => chat._meta?.messageCount !== 0 && !seen.has(chat.sessionId) && seen.add(chat.sessionId));
	return shown.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** The chats not shown yet, split into those whose folder is gone (moved, renamed or deleted) and the rest. */
export function otherFolderChats(
	chats: SavedSession[],
	shown: Set<string>,
	folderExists: (path: string) => boolean,
): { moved: SavedSession[]; other: SavedSession[] } {
	const rest = chatsToShow(chats).filter(chat => !shown.has(chat.sessionId));
	return { moved: rest.filter(chat => !folderExists(chat.cwd)), other: rest.filter(chat => folderExists(chat.cwd)) };
}
