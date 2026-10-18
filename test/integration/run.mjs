// Starts a separate, throwaway VS Code with this extension and runs a suite in it.
// Default suite: suite.js against a real omp (uses a few model tokens).
// `offline`: offline.js against test/fixtures/fake-omp.mjs (no model, no network).
// Set VSCODE_PATH to an installed VS Code executable to skip the download.
// Usage: npm run build && node test/integration/run.mjs [offline]
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

const offline = process.argv[2] === "offline";
const fakeLog = join(workspace, ".fake-omp.log");
// The real suite drags files onto the chat through the window's DevTools protocol, on a free port.
const cdpPort = offline
	? undefined
	: await new Promise(resolvePort => {
			const server = createServer().listen(0, "127.0.0.1", () => {
				const { port } = server.address();
				server.close(() => resolvePort(port));
			});
		});
if (offline) {
	mkdirSync(join(workspace, ".vscode"));
	writeFileSync(
		join(workspace, ".vscode", "settings.json"),
		JSON.stringify({ "omp.path": join(root, "test", "fixtures", "fake-omp.mjs"), "omp.extraArgs": ["--log", fakeLog] }),
	);
}

try {
	await runTests({
		...(process.env.VSCODE_PATH ? { vscodeExecutablePath: process.env.VSCODE_PATH } : {}),
		extensionDevelopmentPath: root,
		extensionTestsPath: join(root, "test", "integration", offline ? "offline.js" : "suite.js"),
		extensionTestsEnv: { OMP_FAKE_LOG: fakeLog, ...(cdpPort ? { OMP_CDP_PORT: String(cdpPort) } : {}) },
		launchArgs: [
			workspace,
			"--user-data-dir",
			userData,
			"--disable-workspace-trust",
			"--disable-extensions",
			...(cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
		],
	});
} catch (error) {
	console.error("Integration test failed:", error);
	process.exit(1);
}
