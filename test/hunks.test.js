const test = require("node:test");
const assert = require("node:assert/strict");
const { applyDecisions, diffFile, fileChangeWarning, parseApprovalMessage, rejectionMessage } = require("../dist/core.js");

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
	for (const cmd of ["sed -i 's/a/b/' x.py", "echo hi > out.txt", "cat <<EOF > f", "rm -rf build", "git checkout -- x", "python3 -c 'open(\"f\",\"w\")'", "ls | tee log"]) {
		assert.ok(fileChangeWarning(cmd), cmd);
	}
	for (const cmd of ["ls -la", "npm test 2>&1", "grep -rn foo src", "git status", "cargo build > /dev/null", "pytest -x"]) {
		assert.equal(fileChangeWarning(cmd), undefined, cmd);
	}
});

test("parses omp approval prompts", () => {
	assert.deepEqual(parseApprovalMessage("Allow tool: edit\nFile: demo.py"), { toolName: "edit", details: "File: demo.py" });
	assert.equal(parseApprovalMessage("Pick a color"), undefined);
});

test("tells the agent exactly what was rejected", () => {
	const diff = diffFile(original, proposed);
	const partial = rejectionMessage("demo.py", diff.hunks, [true, false]);
	assert.match(partial, /accepted 1 of 2/);
	assert.match(partial, /\+    """Sum."""/);
	assert.match(partial, /Continue with the rest of the task/);
	assert.match(rejectionMessage("demo.py", diff.hunks, [false, false]), /NOT modified/);
});
