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

if (watch) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
} else {
	await esbuild.build(options);
}
