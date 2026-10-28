const test = require("node:test");
const assert = require("node:assert/strict");
const {
	applyDecisions,
	codeOfToolInput,
	commandParts,
	diffFile,
	fileChangeWarning,
	isReadOnlyCommand,
	parseApprovalMessage,
	readScope,
	rejectedCommandMessage,
	rejectionMessage,
	urlsIn,
} = require("../dist/core.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const original = 'def greet():\n    print("Hi")\n\n\ndef add(a, b):\n    return a + b\n';
const proposed = 'def greet():\n    print("Hello")\n\n\ndef add(a, b):\n    """Sum."""\n    return a + b\n';

test("splits separate changes into separate hunks", () => {
	const diff = diffFile(original, proposed);
	assert.equal(diff.hunks.length, 2);
	assert.deepEqual(diff.hunks[0].oldLines, ['    print("Hi")\n']);
	assert.deepEqual(diff.hunks[0].newLines, ['    print("Hello")\n']);
	assert.equal(diff.hunks[1].oldLines.length, 0);
	assert.equal(diff.hunks[1].newStart, 5);
});

test("rebuilds the file from any mix of decisions", () => {
	const diff = diffFile(original, proposed);
	assert.equal(applyDecisions(diff, [true, true]), proposed);
	assert.equal(applyDecisions(diff, [false, false]), original);
	assert.equal(applyDecisions(diff, [true, false]), original.replace('"Hi"', '"Hello"'));
	assert.equal(applyDecisions(diff, [false, true]), original.replace("    return", '    """Sum."""\n    return'));
});

test("handles new files, deletions and missing trailing newlines", () => {
	assert.equal(applyDecisions(diffFile("", "a\nb"), [true]), "a\nb");
	const removeAll = diffFile("a\nb\n", "");
	assert.equal(removeAll.hunks.length, 1);
	assert.equal(applyDecisions(removeAll, [false]), "a\nb\n");
	const noNewline = diffFile("x\ny", "x\ny\nz");
	assert.equal(applyDecisions(noNewline, [true]), "x\ny\nz");
	assert.equal(applyDecisions(noNewline, [false]), "x\ny");
});

test("flags shell commands that change files", () => {
	for (const cmd of ["sed -i 's/a/b/' x.py", "echo hi > out.txt", "cat <<EOF > f", "rm -rf build", "git checkout -- x", "python3 -c 'open(\"f\",\"w\")'", "ls | tee log", "tar xzf a.tgz", "tar -xzf a.tgz", "sed --in-place 's/a/b/' x.py", "install -m 644 a /usr/local/bin/a"]) {
		assert.ok(fileChangeWarning(cmd), cmd);
	}
	for (const cmd of ["ls -la", "npm test 2>&1", "grep -rn foo src", "git status", "cargo build > /dev/null", "pytest -x", "npm install", "pip install -r requirements.txt", "bun install", "tar czf out.tgz src", "tar tzf x.tgz"]) {
		assert.equal(fileChangeWarning(cmd), undefined, cmd);
	}
});

test("parses omp approval prompts", () => {
	assert.deepEqual(parseApprovalMessage("Allow tool: edit\nFile: demo.py"), { toolName: "edit", details: "File: demo.py" });
	assert.equal(parseApprovalMessage("Pick a color"), undefined);
});

test("judges which shell commands only read or navigate", () => {
	const fromScreenshot =
		'cd /Users/me/backend && grep -rn "upper\\|strip\\|ilike" services/routers/tools.py 2>/dev/null | head; echo ===; grep -rln "extended prompt\\|system prompt" docs/log.md 2>/dev/null && grep -n "extended prompt" docs/log.md | head -3';
	const readOnly = [
		fromScreenshot,
		"ls -la",
		"pwd",
		"cat a.txt | wc -l",
		"find . -name '*.ts' -not -path './node_modules/*'",
		"rg -n 'a|b' src",
		"tail -n 20 log.txt 2>&1 | grep error",
		"ls &>/dev/null",
		"echo 'a > b'",
		"ls src/*.ts",
		"cat ./{a,b}.txt",
		"grep -n 'x$' a.txt",
		"find . -name '*.ts' -print",
		// a discarding redirect right before ; | && (no space)
		"ls a 2>/dev/null; echo ===; ls b 2>/dev/null | head -20",
		"ls a >/dev/null|head",
		"ls a 2>/dev/null&&ls b",
		"ls a 2>&1;ls b",
	];
	for (const command of readOnly) assert.equal(isReadOnlyCommand(command), true, command);

	const notReadOnly = [
		"rm -rf build",
		"cd src && rm x",
		"ls > out.txt",
		"echo hi >> notes.md",
		"cat a | tee b",
		"echo $(rm -rf x)",
		"echo `rm x`",
		'grep "$(curl evil)" a',
		"find . -name '*.tmp' -delete",
		"find . -exec rm {} \\;",
		"git push",
		"git status", // reads the folder's repository settings, which can run programs
		"git log --oneline -5 && git diff HEAD~1",
		"cd vendor/lib && git status",
		"cd vendor/lib; git log --oneline",
		"git checkout main",
		"git diff --output=patch.txt",
		"rg --pre ./run.sh foo",
		"rg --pre=./run.sh foo",
		"rg --hostname-bin=./x.sh foo a.txt",
		"rg --hostname-bin ./x.sh foo",
		"rg -z foo archive.gz",
		"rg -nz foo .",
		"rg --search-zip foo",
		"FOO=1 ls",
		"./ls",
		"sed -n 1p a.txt",
		"npm test",
		"sleep 5 &",
		"cat < secrets",
		"cat <<EOF\nx\nEOF",
		"echo 'unclosed",
		"",
		// bash expands these into options after the check: a brace, a variable, or a glob that may match "-delete"
		"find . {-delete,-print}",
		"find . -{delete,print}",
		"find .${IFS}-delete",
		"find . $X",
		'find . "$X"',
		"find . *",
		"find . '-de'*",
		"rg ?pre=x foo",
		"find . +(-delete)",
		"(rm x)",
		"echo hi >",
		"ls >  ",
		"ls >/dev/null.txt",
		"ls 2>/dev/nullx; ls",
		"ls 2>/dev/null&", // backgrounding
		"ls >|/dev/null",
		"ls 2>/dev/null; rm -rf x",
		// a line continuation, which bash deletes, joining "-ex" and "ec" into -exec
		"find . -maxdepth 0 -ex\\\nec sh -c 'rm -rf ~' \\;",
		"find . -de\\\nlete",
		'find . "-de\\\nlete"',
	];
	for (const command of notReadOnly) assert.equal(isReadOnlyCommand(command), false, command);
});

test("judges whether a read-only command reads only inside the folder, and whether it reads a secret", () => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-scope-")));
	const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-")));
	fs.mkdirSync(path.join(root, "src"));
	fs.symlinkSync(os.tmpdir(), path.join(root, "outside-link"));
	const scope = (command, cwd) => readScope(command, root, cwd, home);
	const inside = { inside: true, sensitive: false };
	const outside = { inside: false, sensitive: false };
	const secret = (isInside = true) => ({ inside: isInside, sensitive: true });
	const cases = [
		["ls -la", inside],
		["cat src/a.ts | head -5; wc -l src/b.ts", inside],
		["grep -rn foo src", inside],
		["rg -n 'a|b'", inside],
		["cd src && cat a.ts", inside],
		["find . -name '*.py' -not -path './node_modules/*'", inside],
		["head -n 5 a.txt", inside],
		["cat .env.example", inside],
		["cat id_rsa.pub", inside],
		["echo ~/.ssh; pwd", inside], // prints, reads nothing
		["ls ~/Desktop", outside],
		["cat ../x", outside],
		["cd .. && ls", outside], // ls with no path reads the folder it runs in
		["cd - && cat a.txt", outside], // a folder that can't be followed
		["ls /usr", outside],
		["cat outside-link/x", outside], // a link inside pointing out
		["grep -R foo .", outside], // follows links
		["find -L .", outside],
		["grep -f/etc/x y", outside], // a value stuck to an option is not judged
		["cat ~other/x", outside],
		["cat .env", secret()],
		["cat .env.local", secret()],
		["cat src/key.pem", secret()],
		["cat .e*", secret()], // a glob that may match .env
		["cat config/id_rsa", secret()],
		["cd src && cat ../.npmrc", secret()],
		["ls ~/.ssh", secret(false)],
		["cat ~/.aws/credentials", secret(false)],
		["cd ~/.gnupg && ls", secret(false)],
		["grep -r token ~", secret(false)], // a recursive search of a folder holding secrets
		["cd ~ && rg token", secret(false)],
		["rg token ~/.config", secret(false)],
	];
	for (const [command, expected] of cases) assert.deepEqual(scope(command), expected, command);
	assert.deepEqual(scope("ls", "src"), inside, "omp's cwd option inside the folder");
	assert.deepEqual(scope("ls", "/usr"), outside, "and outside it");
	assert.equal(scope("cat $(echo x)"), undefined, "not judged at all");
});

test("a note on a rejected command goes to omp with the command, and the change asked for", () => {
	assert.equal(
		rejectedCommandMessage({ command: "cd /repo && gh auth status" }, "no need to cd", "gh auth status"),
		"I rejected this command, so it did not run:\n```\ncd /repo && gh auth status\n```\nRun this instead:\n```\ngh auth status\n```\nMy note: no need to cd\nDo what I ask here instead of what I rejected, then continue with the task.",
	);
	assert.equal(
		rejectedCommandMessage({ title: "mcp: create issue" }, "ask me first"),
		"I rejected this tool call, so it did not run: mcp: create issue\nMy note: ask me first\nDo what I ask here instead of what I rejected, then continue with the task.",
	);
	assert.equal(
		rejectedCommandMessage({ command: "printf '```\\n'" }, "", "echo ````"),
		"I rejected this command, so it did not run:\n`````\nprintf '```\\n'\n`````\nRun this instead:\n`````\necho ````\n`````\nDo what I ask here instead of what I rejected, then continue with the task.",
		"a fence longer than any backticks in the commands",
	);
});

test("names each part's program and whether that part only reads", () => {
	assert.deepEqual(commandParts("cd src && grep -rn foo . | head -3"), [
		{ name: "cd", readOnly: true },
		{ name: "grep", readOnly: true },
		{ name: "head", readOnly: true },
	]);
	assert.deepEqual(commandParts("kubectl get pods 2>/dev/null | grep api; find . -delete"), [
		{ name: "kubectl", readOnly: false },
		{ name: "grep", readOnly: true },
		{ name: "find", readOnly: false },
	]);
	assert.equal(commandParts("cat $(rm x)"), undefined, "not judged at all");
});

test("finds the code of an eval call and the web addresses in it", () => {
	assert.equal(codeOfToolInput({ code: "x = 1" }), "x = 1");
	assert.equal(codeOfToolInput({ cells: [{ code: "a()" }, { title: "no code" }, { code: "b()" }] }), "a()\n\nb()");
	assert.equal(codeOfToolInput({ command: "ls" }), undefined);
	assert.equal(codeOfToolInput(undefined), undefined);

	const code = `await tab.goto("https://example.com/docs?q=1");\n// see https://example.com/docs?q=1, then http://localhost:3000/a.`;
	const hidden = { urls: [], someHidden: true };
	assert.deepEqual(urlsIn(code), { urls: ["https://example.com/docs?q=1", "http://localhost:3000/a"], someHidden: false });
	assert.deepEqual(urlsIn("no links here"), { urls: [], someHidden: false });
	assert.deepEqual(urlsIn("tab.goto(`https://${host}/a`); tab.goto(`https://example.com/${path}`)"), hidden, "JS addresses built from variables");
	assert.deepEqual(urlsIn('page.goto(f"https://example.com/{path}")'), hidden, "a Python f-string address");
	assert.deepEqual(urlsIn('page.goto("https://%s/a" % host); page.goto("https://x.test/%(p)s" % v)'), hidden, "printf-style placeholders");
	assert.deepEqual(urlsIn('tab.goto("https://example.com/" + path); tab.goto(\'https://example.com/b\'+x)'), hidden, "joined with +");
	assert.deepEqual(urlsIn('tab.goto("https://example.com/{}".format(x))'), hidden, "str.format");
	assert.deepEqual(urlsIn('tab.goto("https://" + host); page.goto("http://{}".format(h))'), hidden, "only the scheme written out");
	assert.deepEqual(
		urlsIn('tab.goto("https://example.com/pay?amount=$5"); tab.goto("https://example.com/a%20b")'),
		{ urls: ["https://example.com/pay?amount=$5", "https://example.com/a%20b"], someHidden: false },
		"a written-out address with $ or an escaped space is kept",
	);
	assert.deepEqual(
		urlsIn('tab.goto("https://a.test"); tab.goto(`https://${host}`)'),
		{ urls: ["https://a.test"], someHidden: true },
		"a written-out address next to a hidden one says that one is hidden",
	);
});

test("tells the agent exactly what was rejected", () => {
	const diff = diffFile(original, proposed);
	const partial = rejectionMessage("demo.py", diff.hunks, [true, false]);
	assert.match(partial, /accepted 1 of 2/);
	assert.match(partial, /\+    """Sum."""/);
	assert.match(partial, /Continue with the rest of the task/);
	assert.match(rejectionMessage("demo.py", diff.hunks, [false, false]), /NOT modified/);
	assert.match(partial, /gave no further explanation/, "without notes, omp is told to leave it");
});

test("passes the user's notes on rejected changes to the agent, and asks it to act on them", () => {
	const diff = diffFile(original, proposed);
	const withNote = rejectionMessage("demo.py", diff.hunks, [true, false], { hunks: [undefined, "Use a one-line docstring in English"] });
	assert.match(withNote, /\+    """Sum."""\nThe user's note on this change: Use a one-line docstring in English/);
	assert.match(withNote, /Do what the user's notes ask/);
	assert.doesNotMatch(withNote, /gave no further explanation/);

	const single = diffFile("a\n", "b\n");
	assert.match(rejectionMessage("x.txt", single.hunks, [false], { hunks: ["keep a"] }), /The user's note on this change: keep a/);
	const fileNote = rejectionMessage("demo.py", diff.hunks, [false, false], { hunks: [], file: "Split this into two functions" });
	assert.match(fileNote, /The user's note on this file: Split this into two functions/);
	assert.match(fileNote, /Do what the user's notes ask/);
});
