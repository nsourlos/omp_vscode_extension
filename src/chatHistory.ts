/** Folds a streamed text chunk into the previous chat message, so the replay history stays small. */

const STREAMED = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

function streamedText(message: any): string | undefined {
	if (message?.type !== "update" || !STREAMED.has(message.update?.sessionUpdate)) return undefined;
	return message.update.content?.type === "text" ? message.update.content.text : undefined;
}

/** The two messages as one, or undefined when they aren't consecutive chunks of the same stream. */
export function mergeChunk(previous: unknown, next: unknown): unknown | undefined {
	const before = streamedText(previous);
	const after = streamedText(next);
	if (before === undefined || after === undefined) return undefined;
	const prev = previous as any;
	if (prev.update.sessionUpdate !== (next as any).update.sessionUpdate) return undefined;
	// Replayed user messages each carry their own messageId (omp's live agent chunks may not keep one, so only these are told apart).
	if (prev.update.sessionUpdate === "user_message_chunk" && prev.update.messageId !== (next as any).update.messageId) return undefined;
	return { ...prev, update: { ...prev.update, content: { type: "text", text: before + after } } };
}
