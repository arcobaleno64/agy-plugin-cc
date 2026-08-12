import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUMP = path.join(ROOT, "scripts", "bump-version.mjs");
const VERIFY = path.join(ROOT, "scripts", "verify-contracts.mjs");
const COMMANDS = ["setup", "review", "adversarial-review", "rescue", "status", "result", "cancel", "transfer"];

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeFixture(version = "0.5.0") {
  const root = makeTempDir();
  writeJson(path.join(root, "package.json"), { name: "@arcobaleno64/gemini-plugin-cc", version });
  writeJson(path.join(root, "package-lock.json"), {
    name: "@arcobaleno64/gemini-plugin-cc",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "@arcobaleno64/gemini-plugin-cc", version } }
  });
  writeJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json"), { name: "gemini", version });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "gemini-plugin-cc",
    metadata: { version },
    plugins: [{ name: "gemini", version, source: "./plugins/gemini" }]
  });
  fs.writeFileSync(path.join(root, "README.md"), "# gemini-plugin-cc\n\n/plugin install gemini@gemini-plugin-cc\n");
  for (const command of COMMANDS) {
    const file = path.join(root, "plugins", "gemini", "commands", `${command}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${command}\n`);
  }
  return root;
}

// --- verify-contracts ---

test("verify-contracts passes on the real repository", () => {
  const result = run("node", [VERIFY], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("verify-contracts passes on a well-formed fixture", () => {
  const result = run("node", [VERIFY, "--root", makeFixture()], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});

test("verify-contracts fails when a manifest version is out of sync", () => {
  const root = makeFixture();
  const pluginFile = path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json");
  writeJson(pluginFile, { ...readJson(pluginFile), version: "9.9.9" });

  const result = run("node", [VERIFY, "--root", root], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugin\.json version/);
});

test("verify-contracts fails when a required command file is missing", () => {
  const root = makeFixture();
  fs.rmSync(path.join(root, "plugins", "gemini", "commands", "cancel.md"));

  const result = run("node", [VERIFY, "--root", root], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cancel\.md/);
});

test("verify-contracts fails when the README install command is missing", () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, "README.md"), "# no install command here\n");

  const result = run("node", [VERIFY, "--root", root], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install command/);
});

// --- CI workflow gates ---

// Both workflows run `claude plugin validate` against a pinned Claude Code. If
// the pins drift apart the PR gate and the release gate stop validating against
// the same schema, and nothing else would report it.
test("both workflows pin the same claude-code version for plugin validation", () => {
  const workflows = ["pull-request-ci.yml", "release.yml"].map((name) => ({
    name,
    text: fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8")
  }));

  const pins = workflows.map(({ name, text }) => {
    const match = text.match(/@anthropic-ai\/claude-code@(\S+)/);
    assert.ok(match, `${name} does not install a pinned @anthropic-ai/claude-code`);
    return match[1];
  });
  assert.equal(pins[0], pins[1], "workflow pins disagree");

  for (const { name, text } of workflows) {
    assert.match(text, /claude plugin validate \.\/plugins\/gemini --strict/, `${name} misses the plugin validate step`);
    assert.match(text, /claude plugin validate \. --strict/, `${name} misses the marketplace validate step`);
  }
});

// --- bump-version (ported from upstream, adapted for the gemini layout) ---

test("bump-version updates every manifest and --check detects drift", () => {
  const root = makeFixture("0.5.0");

  const bumped = run("node", [BUMP, "--root", root, "1.2.3"], { cwd: ROOT });
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");

  // Desync package.json and confirm --check reports the mismatch.
  writeJson(path.join(root, "package.json"), { name: "@arcobaleno64/gemini-plugin-cc", version: "1.2.4" });
  const checked = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /out of sync/i);
});

// A release whose manifests all agree and whose changelog says nothing about the
// version passes every other gate: the four manifests are mechanically consistent,
// contracts verify, and the release workflow's tag assertion compares the tag to
// package.json — which was bumped. The one artifact that tells a user what changed
// was the only one nothing checked. Surfaced by a code review of the v0.17.3
// release commit, which did have its entry.
test("--check fails when the changelog has no entry for the version", () => {
  const root = makeFixture("1.2.3");
  const changelog = path.join(root, "plugins", "gemini", "CHANGELOG.md");
  fs.mkdirSync(path.dirname(changelog), { recursive: true });
  fs.writeFileSync(changelog, "# Changelog\n\n## 1.2.2 — 2026-01-01 — something else\n");

  const missing = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(missing.status, 0, "a release with no changelog entry must not pass");
  assert.match(missing.stderr, /no `## 1\.2\.3` entry/);

  fs.appendFileSync(changelog, "\n## 1.2.3 — 2026-01-02 — the entry\n");
  const present = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /changelog has an entry/);
});

// A near-miss must not satisfy it: `## 1.2.30` starts with the same characters as
// 1.2.3, and a prefix match would have accepted the wrong release's entry.
test("--check does not accept a longer version as the entry", () => {
  const root = makeFixture("1.2.3");
  const changelog = path.join(root, "plugins", "gemini", "CHANGELOG.md");
  fs.mkdirSync(path.dirname(changelog), { recursive: true });
  fs.writeFileSync(changelog, "# Changelog\n\n## 1.2.30 — 2026-01-01 — a different release\n");

  const result = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
});

// The fixtures do not ship a changelog, and a missing file is not a version
// metadata problem — the existing bump-version test would otherwise start failing
// for a reason unrelated to what it pins.
test("--check stays silent about a changelog that does not exist", () => {
  const root = makeFixture("1.2.3");
  const result = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});
