import { copyFile, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
	entryPoints: { extension: "src/extension.ts", core: "src/core.ts" },
	outdir: "dist",
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["vscode"],
	sourcemap: true,
	logLevel: "info",
};

/** The chat page's markdown renderer, loaded by the webview as the global `ompMarkdown`. */
const webview = {
	entryPoints: { markdown: "src/webview/markdown.ts" },
	outdir: "dist",
	bundle: true,
	platform: "browser",
	format: "iife",
	globalName: "ompMarkdown",
	target: "chrome120",
	minify: true,
	sourcemap: true,
	logLevel: "info",
};

/** Mermaid's own browser build (global `mermaid`), which the chat page loads when a reply first holds a diagram. */
async function copyMermaid() {
	await mkdir("dist", { recursive: true });
	await copyFile("node_modules/mermaid/dist/mermaid.min.js", "dist/mermaid.js");
}

if (watch) {
	await copyMermaid();
	for (const build of [options, webview]) await (await esbuild.context(build)).watch();
} else {
	await Promise.all([esbuild.build(options), esbuild.build(webview), copyMermaid()]);
}
