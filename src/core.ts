/** VS Code-free modules, bundled separately so they can be tested with plain Node. */
export { OmpAgent, resolveOmpCommand } from "./omp/agent";
export { fileChangeWarning, parseApprovalMessage, rejectionMessage, PREFER_EDIT_TOOL_PROMPT } from "./omp/policy";
export { applyDecisions, describeHunk, diffFile, splitLines } from "./review/hunks";
export { RpcError } from "./acp/rpc";
export { mergeChunk } from "./chatHistory";
