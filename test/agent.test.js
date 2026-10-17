const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
	OmpAgent,
	addMcpServerToFile,
	addSavedLogins,
	ensureMcpConfigFile,
	failedMcpServers,
	loadMcpServers,
	mcpConfigFiles,
	mcpServerNameProblem,
	ompSavedToken,
	splitCommandLine,
	suggestMcpServerName,
} = require("../dist/core.js");
const { lstatSync, mkdirSync, statSync, symlinkSync } = require("node:fs");

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

test("an mcp.json with the wrong shape is reported, and its good servers still load", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-test-"));
	const write = (name, value) => {
		const file = join(dir, name);
		writeFileSync(file, JSON.stringify(value));
		return file;
	};
	const files = [
		write("null.json", null),
		write("list.json", { mcpServers: [] }),
		write("entries.json", {
			mcpServers: {
				empty: null,
				badArgs: { command: "x", args: "--foo" },
				badEnv: { command: "x", env: ["A=1"] },
				badHeaders: { url: "https://h.example", headers: "Bearer x" },
				good: { command: "ok", args: ["1"] },
			},
		}),
	];
	const { servers, problems } = loadMcpServers(files);
	assert.deepEqual(servers, [{ name: "good", command: "ok", args: ["1"], env: [] }]);
	assert.equal(problems.length, 6, problems.join("\n"));
	assert.match(problems[0], /null\.json: "mcpServers" should be an object/);
	assert.match(problems[1], /list\.json: "mcpServers" should be an object/);
	assert.match(problems[2], /"empty" is not an object/);
	assert.match(problems[3], /"badArgs" has "args" that is not a list/);
	assert.match(problems[4], /"badEnv" has "env" that is not an object/);
	assert.match(problems[5], /"badHeaders" has "headers" that is not an object/);
});

test("only the servers omp names as failed are left out, even when one name ends another", () => {
	const server = name => ({ name, command: "x", args: [], env: [] });
	const servers = [server("cloud"), server("jira-cloud"), server("files"), server("a.b")];
	const names = message => failedMcpServers(servers, message).map(s => s.name);
	assert.deepEqual(names("jira-cloud: connection refused"), ["jira-cloud"]);
	assert.deepEqual(names("Internal error: cloud: timeout; files: exited"), ["cloud", "files"]);
	assert.deepEqual(names("axb: nope"), [], "a name is matched literally");
	const spaced = [server("server"), server("my server"), server("error"), server("found")];
	const spacedNames = message => failedMcpServers(spaced, message).map(s => s.name);
	assert.deepEqual(spacedNames("Internal error: my server: refused"), ["my server"], "not 'server', nor 'error' from 'Internal error:'");
	assert.deepEqual(spacedNames("Internal error: ACP session not found: abc"), [], "not 'found' from 'not found:'");
	assert.deepEqual(spacedNames("Internal error: server: refused; my server: timeout"), ["server", "my server"]);
});

test("a project's MCP servers are used only in a trusted workspace", () => {
	const files = mcpConfigFiles("/work/project", true);
	assert.equal(files.length, 3);
	assert.deepEqual(mcpConfigFiles("/work/project", false), [files[0]], "untrusted: only the user's own omp config");
});

test("saved sign-ins are looked up all at once", async () => {
	let running = 0;
	let most = 0;
	const savedToken = async () => {
		most = Math.max(most, ++running);
		await sleep(20);
		running--;
		return undefined;
	};
	const web = name => ({ name, type: "http", url: `https://${name}.example/mcp`, headers: [] });
	await addSavedLogins([web("a"), web("b"), web("c")], savedToken);
	assert.equal(most, 3);
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
			{ name: "broken-api", type: "http", url: "https://nowhere.example/mcp?api_key=SECRET-KEY", headers: [] },
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
		assert.match(agent.mcpProblems.join("\n"), /broken-api: connection refused \(https:\/\/nowhere\.example\/mcp\?…/);
		assert.doesNotMatch(agent.mcpProblems.join("\n"), /SECRET-KEY/, "a key in the server's address is not shown in the chat");
		const attempts = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line).mcpServers);
		assert.deepEqual(attempts, [["files", "broken-api"], ["files"]], "retried with only the server that works");
	} finally {
		agent.dispose();
	}
});

/** An agent on the fake omp that logs to `lines`; its fake-omp log is read with `attempts()`. */
function fakeAgent({ args = [], mcpServers, lines = [] } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "omp-agent-test-"));
	const log = join(dir, "fake.log");
	const agent = new OmpAgent({
		command: join(__dirname, "fixtures", "fake-omp.mjs"),
		args: ["--log", log, ...args],
		cwd: dir,
		mcpServers,
		handlers: {
			readTextFile: async () => "",
			writeTextFile: async () => {},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			elicit: async () => ({ action: "cancel" }),
			onSessionUpdate: () => {},
			onExit: () => {},
			log: line => lines.push(line),
		},
	});
	const attempts = () => readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(e => e.event === "session/new").map(e => e.mcpServers);
	return { agent, attempts };
}

test("MCP secrets (in env, headers, args or url) stay out of the log, but are sent to omp", async () => {
	const lines = [];
	const { agent, attempts } = fakeAgent({
		lines,
		mcpServers: [
			{ name: "api", type: "http", url: "https://mcp.example.com/sse?api_key=secret-in-url", headers: [{ name: "Authorization", value: "Bearer secret-token" }] },
			{ name: "files", command: "npx", args: ["--token", "secret-arg"], env: [{ name: "API_KEY", value: "secret-key" }] },
		],
	});
	try {
		await agent.start();
		const sent = lines.find(line => line.startsWith("→") && line.includes("session/new"));
		assert.ok(sent, "the request is logged");
		assert.doesNotMatch(lines.join("\n"), /secret-/);
		assert.match(sent, /"mcpServers":\[\{"name":"api","type":"http"\},\{"name":"files","type":"stdio"\}\]/);
		assert.deepEqual(attempts(), [["api", "files"]], "omp still gets both servers");
	} finally {
		agent.dispose();
	}
});

test("a session error that isn't about MCP is reported as it is, without dropping the MCP servers", async () => {
	const { agent, attempts } = fakeAgent({ args: ["--fail-new", "no model configured"], mcpServers: [{ name: "files", command: "npx", args: [], env: [] }] });
	try {
		await assert.rejects(agent.start(), /no model configured/);
		assert.deepEqual(attempts(), [["files"]], "not retried without the servers");
		assert.deepEqual(agent.mcpProblems, []);
	} finally {
		agent.dispose();
	}
	const mcp = fakeAgent({ args: ["--fail-new", "MCP startup failed"], mcpServers: [{ name: "files", command: "npx", args: [], env: [] }] });
	try {
		await assert.rejects(mcp.agent.start(), /MCP startup failed/, "the fake fails every attempt");
		assert.deepEqual(mcp.attempts(), [["files"], []], "an MCP error naming no server is retried without any");
	} finally {
		mcp.agent.dispose();
	}
});

test("the MCP servers can still be resolving while omp starts", async () => {
	const { agent, attempts } = fakeAgent({ mcpServers: sleep(100).then(() => [{ name: "late", command: "npx", args: [], env: [] }]) });
	try {
		await agent.start();
		assert.deepEqual(attempts(), [["late"]]);
	} finally {
		agent.dispose();
	}
});

test("every page of saved chats is listed", async () => {
	const { agent } = fakeAgent({ args: ["--page-size", "2"] });
	try {
		await agent.connect();
		const sessions = await agent.listSessions();
		assert.deepEqual(sessions.map(session => session.sessionId), ["empty-1", "saved-1", "saved-0"]);
	} finally {
		agent.dispose();
	}
});

test("${VAR:-default} in an mcp.json uses the default when VAR is unset or empty", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-test-"));
	const file = join(dir, "mcp.json");
	process.env.OMP_TEST_SET = "set.example";
	process.env.OMP_TEST_EMPTY = "";
	delete process.env.OMP_TEST_UNSET;
	writeFileSync(
		file,
		JSON.stringify({
			mcpServers: {
				a: { url: "https://${OMP_TEST_UNSET:-fallback.example}/sse", headers: { X: "${OMP_TEST_EMPTY:-dflt}", Y: "${OMP_TEST_SET:-unused}", Z: "${OMP_TEST_UNSET}" } },
			},
		}),
	);
	const [server] = loadMcpServers([file]).servers;
	assert.equal(server.url, "https://fallback.example/sse");
	assert.deepEqual(server.headers, [
		{ name: "X", value: "dflt" },
		{ name: "Y", value: "set.example" },
		{ name: "Z", value: "" },
	]);
});

test("a server added from the extension goes into omp's mcp.json, keeping what is there, and is used from then on", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-add-"));
	const file = join(dir, ".omp", "mcp.json");
	addMcpServerToFile(file, "files", { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { KEY: "${MY_KEY}" } });
	assert.equal(statSync(file).mode & 0o777, 0o600, "only its owner can read it: it may hold keys");
	const written = JSON.parse(readFileSync(file, "utf8"));
	assert.match(written.$schema, /mcp-schema\.json$/, "like the files omp writes");
	written.disabledServers = ["old"];
	written.mcpServers.old = { command: "old" };
	writeFileSync(file, JSON.stringify(written));

	addMcpServerToFile(file, "jira", { type: "http", url: "https://mcp.atlassian.com/v1/mcp", headers: {} });
	const config = JSON.parse(readFileSync(file, "utf8"));
	assert.deepEqual(Object.keys(config.mcpServers), ["files", "old", "jira"]);
	assert.deepEqual(config.mcpServers.files, { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], env: { KEY: "${MY_KEY}" } });
	assert.deepEqual(config.mcpServers.jira, { type: "http", url: "https://mcp.atlassian.com/v1/mcp" }, "no empty headers");
	assert.deepEqual(config.disabledServers, ["old"], "the rest of the file is kept");

	const { servers } = loadMcpServers([file]);
	assert.deepEqual(servers.map(server => server.name), ["files", "jira"], "a server turned off with omp's /mcp disable is left out");

	assert.throws(() => addMcpServerToFile(file, "files", { type: "stdio", command: "x", args: [], env: {} }), /already an MCP server called "files"/);
	assert.throws(() => addMcpServerToFile(file, "bad/name", { type: "stdio", command: "x", args: [], env: {} }), /Use only letters/);
	addMcpServerToFile(file, "constructor", { type: "stdio", command: "x", args: [], env: {} }); // not taken for a built-in name
	assert.ok(JSON.parse(readFileSync(file, "utf8")).mcpServers.constructor);
});

test("a broken mcp.json is never overwritten when adding a server", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-add-"));
	const file = join(dir, "mcp.json");
	writeFileSync(file, "{ not json");
	assert.throws(() => addMcpServerToFile(file, "files", { type: "stdio", command: "x", args: [], env: {} }), /not valid JSON.*Fix or remove it first/);
	ensureMcpConfigFile(file); // opening it to fix the mistake works
	assert.equal(readFileSync(file, "utf8"), "{ not json", "and leaves it as it is");
	const fresh = join(dir, "new", "mcp.json");
	ensureMcpConfigFile(fresh);
	assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")).mcpServers, {}, "an empty file to edit is created when there is none");
});

test("server names, command lines and suggested names for a new MCP server", () => {
	assert.equal(mcpServerNameProblem("github"), undefined);
	assert.equal(mcpServerNameProblem("MaaS Slack"), undefined, "single spaces are fine, as in omp");
	assert.match(mcpServerNameProblem(""), /name/);
	assert.match(mcpServerNameProblem("a  b"), /single spaces/);

	assert.deepEqual(splitCommandLine(`npx -y "@scope/pkg name" 'a b' c\\ d`), ["npx", "-y", "@scope/pkg name", "a b", "c d"]);
	assert.equal(splitCommandLine(`npx "open`), undefined);
	assert.deepEqual(splitCommandLine(String.raw`node C:\tools\mcp\server.js`), ["node", String.raw`C:\tools\mcp\server.js`], "a Windows path keeps its backslashes");
	assert.deepEqual(splitCommandLine(String.raw`node "C:\Program Files\mcp\server.js"`), ["node", String.raw`C:\Program Files\mcp\server.js`]);
	assert.equal(suggestMcpServerName("stdio", String.raw`node C:\tools\github-mcp\index.js`), "index.js");
	assert.deepEqual(splitCommandLine(String.raw`node \\server\share\mcp.js`), ["node", String.raw`\\server\share\mcp.js`], "a network path keeps both backslashes");
	assert.equal(suggestMcpServerName("http", "http://127.0.0.1:3000/mcp"), "local");
	assert.equal(suggestMcpServerName("http", "http://localhost:3000/mcp"), "local");
	assert.equal(suggestMcpServerName("http", "https://mcp.example.co.uk/mcp"), "example");

	assert.equal(suggestMcpServerName("stdio", "npx -y @modelcontextprotocol/server-filesystem ."), "filesystem");
	assert.equal(suggestMcpServerName("stdio", "uvx mcp-server-fetch@latest"), "fetch");
	assert.equal(suggestMcpServerName("stdio", "docker run -i --rm ghcr.io/github/github-mcp-server"), "github");
	assert.equal(suggestMcpServerName("http", "https://mcp.atlassian.com/v1/mcp"), "atlassian");
	assert.equal(suggestMcpServerName("sse", "https://example.com/sse", new Set(["example"])), "example-2", "a free name");
});

test("adding a server to a symlinked mcp.json (say from a dotfiles repo) writes through the link", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-link-"));
	const real = join(dir, "dotfiles", "mcp.json");
	mkdirSync(join(dir, "dotfiles"));
	writeFileSync(real, JSON.stringify({ mcpServers: { kept: { command: "x" } } }));
	mkdirSync(join(dir, "agent"));
	const link = join(dir, "agent", "mcp.json");
	symlinkSync(real, link);
	addMcpServerToFile(link, "added", { type: "stdio", command: "y", args: [], env: {} });
	assert.ok(lstatSync(link).isSymbolicLink(), "still a link");
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(real, "utf8")).mcpServers), ["kept", "added"]);

	const dangling = join(dir, "agent", "new.json");
	symlinkSync(join(dir, "dotfiles", "new.json"), dangling);
	ensureMcpConfigFile(dangling);
	assert.ok(lstatSync(dangling).isSymbolicLink(), "a link to a file not made yet stays a link");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "dotfiles", "new.json"), "utf8")).mcpServers, {});
});

test("reloading a chat the editor already shows drops only omp's replay, not its other updates", async () => {
	const updates = [];
	const dir = mkdtempSync(join(tmpdir(), "omp-agent-test-"));
	const agent = new OmpAgent({
		command: join(__dirname, "fixtures", "fake-omp.mjs"),
		args: [],
		cwd: dir,
		handlers: {
			readTextFile: async () => "",
			writeTextFile: async () => {},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			elicit: async () => ({ action: "cancel" }),
			onSessionUpdate: update => updates.push(update.sessionUpdate),
			onExit: () => {},
			log: () => {},
		},
	});
	try {
		await agent.start("with-updates", { replay: false });
		assert.deepEqual(updates, ["available_commands_update", "usage_update"]);
	} finally {
		agent.dispose();
	}
});

test("omp exiting while it opens a session is not taken for an MCP failure, even with 'mcp' in its output", async () => {
	const { agent, attempts } = fakeAgent({ args: ["--exit-on-new", "cannot read /work/mcp/config"], mcpServers: [{ name: "files", command: "npx", args: [], env: [] }] });
	try {
		await assert.rejects(agent.start(), /omp exited/);
		assert.deepEqual(attempts(), [["files"]], "not retried without the servers");
		assert.deepEqual(agent.mcpProblems, [], "no warning blaming MCP");
	} finally {
		agent.dispose();
	}
});

test("keys in web address queries stay out of the log, in both directions and in omp's own output", async () => {
	const lines = [];
	const { agent } = fakeAgent({
		lines,
		args: ["--fail-new", "jira: failed to connect to https://h.example/mcp?api_key=SECRET-1"],
		mcpServers: [{ name: "jira", type: "http", url: "https://h.example/mcp?api_key=SECRET-1", headers: [] }],
	});
	try {
		await assert.rejects(agent.start());
		const log = lines.join("\n");
		assert.match(log, /← .*https:\/\/h\.example\/mcp\?…/, "omp's error is logged, without the key");
		assert.doesNotMatch(log, /SECRET-1/);
	} finally {
		agent.dispose();
	}
	const stderr = [];
	const exiting = fakeAgent({ lines: stderr, args: ["--exit-on-new", "GET https://h.example/sse?token=SECRET-2 failed"] });
	try {
		await assert.rejects(exiting.agent.start());
		assert.match(stderr.join("\n"), /\[omp stderr\] GET https:\/\/h\.example\/sse\?… failed/);
		assert.doesNotMatch(stderr.join("\n"), /SECRET-2/);
	} finally {
		exiting.agent.dispose();
	}
});

test("only the user's own omp config can turn MCP servers off, not a project's file", () => {
	const dir = mkdtempSync(join(tmpdir(), "omp-mcp-disabled-"));
	const user = join(dir, "user.json");
	const project = join(dir, "project.json");
	writeFileSync(user, JSON.stringify({ mcpServers: { github: { command: "gh" }, old: { command: "old" } }, disabledServers: ["old"] }));
	writeFileSync(project, JSON.stringify({ mcpServers: {}, disabledServers: ["github"] }));
	assert.deepEqual(loadMcpServers([user, project]).servers.map(server => server.name), ["github"]);
});

test("a key in a web address omp prints in two pieces is still hidden in the log", async () => {
	const logged = [];
	const agent = new OmpAgent({
		command: join(__dirname, "fixtures", "fake-omp.mjs"),
		args: ["--stderr-split"],
		cwd: mkdtempSync(join(tmpdir(), "omp-agent-test-")),
		handlers: {
			readTextFile: async () => "",
			writeTextFile: async () => {},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			elicit: async () => ({ action: "cancel" }),
			onSessionUpdate: () => {},
			onExit: () => {},
			log: line => logged.push(line),
		},
	});
	try {
		await agent.start();
		await sleep(200); // the second piece arrives 30 ms after the first
	} finally {
		agent.dispose();
	}
	const stderr = logged.filter(line => line.startsWith("[omp stderr]"));
	assert.deepEqual(stderr, ["[omp stderr] could not reach https://mcp.example/v1?… (timeout)"]);
	assert.ok(!logged.some(line => line.includes("SPLIT-SECRET")));
});
