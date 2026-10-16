/** The slice of the Agent Client Protocol (ACP v1) this extension uses. */

export const PROTOCOL_VERSION = 1;

export interface TextContent {
	type: "text";
	text: string;
}

export interface PermissionOption {
	optionId: string;
	name: string;
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface ToolCallInfo {
	toolCallId: string;
	title?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	rawInput?: any;
	rawOutput?: any;
	content?: any[];
	locations?: { path: string; line?: number }[];
}

export interface RequestPermissionParams {
	sessionId: string;
	toolCall: ToolCallInfo;
	options: PermissionOption[];
}

export type RequestPermissionResult =
	| { outcome: { outcome: "selected"; optionId: string } }
	| { outcome: { outcome: "cancelled" } };

export interface ElicitationProperty {
	type: string;
	title?: string;
	description?: string;
	enum?: string[];
	oneOf?: { const: string; title?: string; description?: string }[];
	default?: unknown;
	items?: unknown;
}

export interface ElicitationParams {
	mode: string;
	sessionId: string;
	message: string;
	requestedSchema?: {
		type: "object";
		properties: Record<string, ElicitationProperty>;
		required?: string[];
	};
	url?: string;
}

export type ElicitationResult =
	| { action: "accept"; content: Record<string, string | number | boolean | string[]> }
	| { action: "decline" | "cancel" };

export interface ReadTextFileParams {
	sessionId: string;
	path: string;
	line?: number;
	limit?: number;
}

export interface WriteTextFileParams {
	sessionId: string;
	path: string;
	content: string;
}

export interface ConfigOption {
	id: string;
	name: string;
	category?: string;
	type: "select";
	currentValue: string;
	options: { value: string; name: string; description?: string }[];
}

export interface SessionUpdate {
	sessionUpdate: string;
	[key: string]: any;
}

/** An MCP server passed in session/new: run as a local command, or reached over http/sse. */
export type McpServer =
	| { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
	| { name: string; type: "http" | "sse"; url: string; headers: { name: string; value: string }[] };

export interface NewSessionResult {
	sessionId: string;
	configOptions?: ConfigOption[];
}

export interface PromptResult {
	stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
	usage?: Record<string, number>;
}
