// Starts a separate, throwaway VS Code with this extension and runs suite.js in it.
// Uses a few model tokens. Set VSCODE_PATH to an installed VS Code executable to skip the download.
// Usage: npm run build && node test/integration/run.mjs
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

// Set when this runs from a terminal inside VS Code; it would start the test VS Code as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspace = mkdtempSync(join(tmpdir(), "omp-it-ws-"));
const userData = mkdtempSync(join(tmpdir(), "omp-it-user-"));
writeFileSync(
	join(workspace, "demo.py"),
	'def greet():\n    print("Hi")\n\n\ndef add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n',
);

try {
	await runTests({
		...(process.env.VSCODE_PATH ? { vscodeExecutablePath: process.env.VSCODE_PATH } : {}),
		extensionDevelopmentPath: root,
		extensionTestsPath: join(root, "test", "integration", "suite.js"),
		launchArgs: [workspace, "--user-data-dir", userData, "--disable-workspace-trust", "--disable-extensions"],
	});
} catch (error) {
	console.error("Integration test failed:", error);
	process.exit(1);
}
