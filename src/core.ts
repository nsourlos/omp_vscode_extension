/** VS Code-free modules, bundled separately so they can be tested with plain Node. */
export { OmpAgent, ompSavedToken, resolveOmpCommand } from "./omp/agent";
export {
	addMcpServerToFile,
	addSavedLogins,
	ensureMcpConfigFile,
	failedMcpServers,
	loadMcpServers,
	mcpConfigFiles,
	mcpServerNameProblem,
	splitCommandLine,
	suggestMcpServerName,
} from "./omp/mcp";
export {
	codeOfToolInput,
	fileChangeWarning,
	isReadOnlyCommand,
	parseApprovalMessage,
	rejectionMessage,
	urlsIn,
	PREFER_EDIT_TOOL_PROMPT,
} from "./omp/policy";
export { applyDecisions, describeHunk, diffFile, splitLines } from "./review/hunks";
export { RpcError } from "./acp/rpc";
export { mergeChunk } from "./chatHistory";
