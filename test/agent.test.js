const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { OmpAgent, addSavedLogins, loadMcpServers, ompSavedToken } = require("../dist/core.js");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test("a reply to an omp that stopped reading raises no uncaught error", async () => {
	let release;
	const agent = new OmpAgent({
		command: join(__dirname, "fixtures", "fake-omp.mjs"),
		args: [],
		cwd: mkdtempSync(join(tmpdir(), "omp-agent-test-")),
		handlers: {
			readTextFile: async () => "",
			writeTextFile: () => new Promise(resolve => (release = resolve)),
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			elicit: async () => ({ action: "cancel" }),
			onSessionUpdate: () => {},
			onExit: () => {},
			log: () => {},
		},
	});
	const errors = [];
	const collect = error => errors.push(error);
	process.on("uncaughtException", collect);
	try {
		await agent.start();
		void agent.prompt(JSON.stringify([{ closeStdin: true }, { write: { path: "x.txt", content: "y" } }])).catch(() => {});
		while (!release) await sleep(10);
		release();
		await sleep(300);
	} finally {
		agent.dispose();
		process.off("uncaughtException", collect);
	}
	assert.deepEqual(errors.map(error => error.code), []);
});

test("reads MCP servers from mcp.json files in the format omp's session/new expects", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-test-"));
	const write = (name, value) => {
		const file = join(dir, name);
		writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
		return file;
	};
	process.env.OMP_TEST_TOKEN = "secret-123";
	const user = write("user.json", {
		mcpServers: {
			files: { type: "stdio", command: "npx", args: ["-y", "server"], env: { KEY: "${OMP_TEST_TOKEN}" } },
			api: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${OMP_TEST_TOKEN}" } },
			events: { type: "sse", url: "https://mcp.example.com/sse" },
			old: { command: "old-server" },
			odd: { type: "stdio" },
		},
	});
	const project = write("project.json", { mcpServers: { files: { command: "uvx", args: ["files"] }, old: { command: "x", disabled: true } } });
	const broken = write("broken.json", "{ not json");

	const { servers, problems } = loadMcpServers([user, project, join(dir, "missing.json"), broken]);
	assert.deepEqual(servers, [
		{ name: "files", command: "uvx", args: ["files"], env: [] },
		{ name: "api", type: "http", url: "https://mcp.example.com/mcp", headers: [{ name: "Authorization", value: "Bearer secret-123" }] },
		{ name: "events", type: "sse", url: "https://mcp.example.com/sse", headers: [] },
	]);
	assert.equal(problems.length, 2, "the server with neither command nor url, and the broken file; a missing file is fine");
	assert.match(problems[0], /"odd" has neither a command nor a url/);
	assert.match(problems[1], /broken\.json/);
	assert.deepEqual(loadMcpServers([user]).servers[0].env, [{ name: "KEY", value: "secret-123" }], "env as a name/value list, ${VAR} filled in");
});

test("web MCP servers without a login get omp's saved sign-in as a header; others are left alone", async () => {
	const asked = [];
	const savedToken = async url => (asked.push(url), url.includes("atlassian") ? "tok-1" : undefined);
	const servers = await addSavedLogins(
		[
			{ name: "atlassian", type: "http", url: "https://mcp.atlassian.com/v2/mcp", headers: [] },
			{ name: "github", type: "http", url: "https://api.github.example/mcp", headers: [{ name: "authorization", value: "Bearer mine" }] },
			{ name: "other", type: "sse", url: "https://other.example/sse", headers: [] },
			{ name: "files", command: "npx", args: [], env: [] },
		],
		savedToken,
	);
	assert.deepEqual(servers[0].headers, [{ name: "Authorization", value: "Bearer tok-1" }]);
	assert.deepEqual(servers[1].headers, [{ name: "authorization", value: "Bearer mine" }], "an existing login is kept");
	assert.deepEqual(servers[2].headers, [], "no saved sign-in: unchanged");
	assert.deepEqual(servers[3], { name: "files", command: "npx", args: [], env: [] });
	assert.deepEqual(asked, ["https://mcp.atlassian.com/v2/mcp", "https://other.example/sse"], "only web servers without a login are looked up");
});

test("omp's saved sign-in is read with `omp token`, and a missing one is no error", async () => {
	const lookup = ompSavedToken(join(__dirname, "fixtures", "fake-omp.mjs"));
	assert.equal(await lookup("https://signed-in.example/mcp"), "fake-token-123");
	assert.equal(await lookup("https://nobody.example/mcp"), undefined);
});

test("an MCP server that won't start is left out instead of failing the whole session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-agent-test-"));
	const log = join(dir, "fake.log");
	const agent = new OmpAgent({
		command: join(__dirname, "fixtures", "fake-omp.mjs"),
		args: ["--log", log],
		cwd: dir,
		mcpServers: [
			{ name: "files", command: "npx", args: [], env: [] },
			{ name: "broken-api", type: "http", url: "https://nowhere.example", headers: [] },
		],
		handlers: {
			readTextFile: async () => "",
			writeTextFile: async () => {},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			elicit: async () => ({ action: "cancel" }),
			onSessionUpdate: () => {},
			onExit: () => {},
			log: () => {},
		},
	});
	try {
		const session = await agent.start();
		assert.ok(session.sessionId, "the session started");
		assert.match(agent.mcpProblems.join("\n"), /broken-api: connection refused/);
		const attempts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).mcpServers);
		assert.deepEqual(attempts, [["files", "broken-api"], ["files"]], "retried with only the server that works");
	} finally {
		agent.dispose();
	}
});
