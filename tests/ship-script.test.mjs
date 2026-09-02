import test from "node:test";
import assert from "node:assert/strict";

import { EXIT, bumpedFiles, insertChangelogEntry, parseArgs, summariseTests, tail } from "../scripts/ship.mjs";

// The script's own steps spawn git, npm and gh, so they are exercised by running
// it. What is unit-tested here is the part that decides WHERE prose lands and
// WHICH exit code a caller sees -- the two things a wrong answer would hide
// rather than announce.

const CHANGELOG = ["# Changelog", "", "## 0.24.3 - 2026-09-02 - Older entry", "", "- something", ""].join("\n");

test("insertChangelogEntry puts the new entry above the newest one", () => {
  const next = insertChangelogEntry(CHANGELOG, "## 0.24.4 - 2026-09-03 - New\n\n- new thing");
  const headings = next.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, ["## 0.24.4 - 2026-09-03 - New", "## 0.24.3 - 2026-09-02 - Older entry"]);
});

test("insertChangelogEntry keeps the title above the first heading", () => {
  const next = insertChangelogEntry(CHANGELOG, "## 0.24.4 - x");
  assert.equal(next.split("\n")[0], "# Changelog");
});

// A fragment appended to the END of a newest-first changelog is invisible to
// readers and still satisfies `bump-version --check`, which only scans for the
// heading anywhere in the file. That combination is why placement is asserted.
test("insertChangelogEntry does not append", () => {
  const next = insertChangelogEntry(CHANGELOG, "## 0.24.4 - x");
  assert.ok(next.indexOf("## 0.24.4") < next.indexOf("## 0.24.3"));
});

test("insertChangelogEntry preserves CRLF files", () => {
  const crlf = CHANGELOG.split("\n").join("\r\n");
  const next = insertChangelogEntry(crlf, "## 0.24.4 - x");
  assert.ok(next.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(next), "mixed line endings would show up as a whole-file diff");
});

test("insertChangelogEntry refuses a changelog with no heading to anchor on", () => {
  assert.throws(() => insertChangelogEntry("# Changelog\n\nnothing yet\n", "## 1.0.0 - x"), (error) => {
    assert.equal(error.code, EXIT.changelogInsertFailed);
    return true;
  });
});

test("parseArgs reads every documented flag", () => {
  const options = parseArgs([
    "--commit", "c.txt", "--changelog", "cl.md", "--pr", "pr.md",
    "--title", "fix: x", "--version", "1.2.3", "--dry-run", "--no-push"
  ]);
  assert.equal(options.commitFile, "c.txt");
  assert.equal(options.changelogFile, "cl.md");
  assert.equal(options.prFile, "pr.md");
  assert.equal(options.title, "fix: x");
  assert.equal(options.version, "1.2.3");
  assert.equal(options.dryRun, true);
  assert.equal(options.noPush, true);
});

// `--title --dry-run` must not silently make the title "--dry-run": that
// swallows the flag AND ships a PR titled with an argument name. Asserted with a
// trailing boolean flag on purpose -- `--title --version 1.2.3` would throw
// anyway, on the leftover `1.2.3`, so it cannot tell the guard from its absence.
test("parseArgs rejects a flag used as another flag's value", () => {
  assert.throws(() => parseArgs(["--title", "--dry-run"]), (error) => {
    assert.equal(error.code, EXIT.usage);
    return true;
  });
});

test("parseArgs rejects an unknown argument rather than ignoring it", () => {
  assert.throws(() => parseArgs(["--force"]), (error) => {
    assert.equal(error.code, EXIT.usage);
    return true;
  });
});

test("every exit code is distinct", () => {
  const codes = Object.values(EXIT);
  assert.equal(new Set(codes).size, codes.length, "a shared code makes the failure unbranchable");
});

test("summariseTests reads the node:test tallies", () => {
  const output = ["ℹ tests 704", "ℹ suites 0", "ℹ pass 696", "ℹ fail 0", "ℹ skipped 8"].join("\n");
  assert.equal(summariseTests(output), "tests 704, pass 696, fail 0, skipped 8");
});

test("summariseTests degrades to a plain statement when the format changes", () => {
  assert.equal(summariseTests("all good"), "tests passed");
});

test("tail keeps the END of the output, where the failure is", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const kept = tail(text, 3).split("\n");
  assert.deepEqual(kept, ["line 47", "line 48", "line 49"]);
});

// The script stages only what it wrote itself, and it learns that list by
// parsing bump-version's own report rather than keeping a second copy of the
// manifest list. A parse that silently returns [] would leave the bumped
// manifests unstaged and still exit 0 -- a release commit with no version in it.
test("bumpedFiles reads the manifest list out of bump-version's report", () => {
  const output = "Set version metadata to 0.24.4: package.json, package-lock.json, "
    + "plugins/gemini/.claude-plugin/plugin.json, .claude-plugin/marketplace.json.";
  assert.deepEqual(bumpedFiles(output), [
    "package.json",
    "package-lock.json",
    "plugins/gemini/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json"
  ]);
});

test("bumpedFiles returns nothing when bump-version changed nothing", () => {
  assert.deepEqual(bumpedFiles("Set version metadata to 0.24.4: no files changed."), []);
});

test("bumpedFiles returns nothing for unrecognised output", () => {
  assert.deepEqual(bumpedFiles("something else entirely"), []);
});
