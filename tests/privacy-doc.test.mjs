import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// PRIVACY.md is a directory-compliance document: an approved plugin has to be
// able to point at one. These assertions keep it present and reachable — the way
// a policy doc actually rots is that a README rewrite drops the link and nobody
// notices, not that the file is deleted.

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

test("PRIVACY.md exists and answers the four directory questions", () => {
  const privacy = read("PRIVACY.md");

  // What leaves the machine, and to whom.
  assert.match(privacy, /Gemini CLI|Antigravity/);
  // What is retained locally, and where.
  assert.match(privacy, /\.omc[/\\]transfers/);
  assert.match(privacy, /state\.json/);
  // What is explicitly not accessed.
  assert.match(privacy, /Claude memory/);
  // The limits of the redaction claim, stated rather than glossed.
  assert.match(privacy, /filename only/);
});

test("every entry document links to PRIVACY.md", () => {
  for (const file of ["README.md", "README.zh-TW.md", "SECURITY.md"]) {
    assert.match(read(file), /\(PRIVACY\.md\)/, `${file} does not link to PRIVACY.md`);
  }
});

// Same failure mode, generalised. Material moved out of a README into docs/ is
// only moved if the pointer resolves; a link that rots leaves the README
// promising an explanation the reader cannot reach, which is worse than the long
// version it replaced. Repo-relative links only — external URLs are not this
// suite's to verify, and anchors are checked no further than the file.
const LINKED = [
  "README.md",
  "README.zh-TW.md",
  "SECURITY.md",
  "PRIVACY.md",
  "CONTRIBUTING.md",
  "plugins/gemini/CHANGELOG.md",
  ...fs.readdirSync(path.join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)
];

test("every repo-relative link in the entry documents resolves", () => {
  for (const file of LINKED) {
    const dir = path.dirname(path.join(ROOT, file));
    for (const match of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [relative] = target.split("#");
      if (!relative) continue;
      const resolved = path.resolve(dir, relative);
      assert.ok(fs.existsSync(resolved), `${file} links to ${target}, which does not exist`);
    }
  }
});

test("SECURITY.md declares support for the shipped minor line", () => {
  const version = JSON.parse(read("package.json")).version;
  const minorLine = `${version.split(".").slice(0, 2).join(".")}.x`;
  assert.match(
    read("SECURITY.md"),
    new RegExp(`\\|\\s*${minorLine.replaceAll(".", "\\.")}\\s*\\|`),
    `SECURITY.md does not list ${minorLine} as supported`
  );
});

// The same guard SECURITY.md already had, on the document that needed it more.
// PRIVACY.md announced itself as applying to 0.16.x for six minor releases --
// and it is the one document whose entire value is that every claim in it can be
// checked against the source. A reader who spot-checks one line and finds the
// version six releases behind has no way to tell which of the remaining claims
// were re-checked and which were carried forward. Nothing in `bump-version`
// touches either file, so only a test keeps them honest.
test("PRIVACY.md declares the minor line it was checked against", () => {
  const version = JSON.parse(read("package.json")).version;
  const minorLine = `${version.split(".").slice(0, 2).join(".")}.x`;
  assert.match(
    read("PRIVACY.md"),
    new RegExp(`Applies to plugin version ${minorLine.replaceAll(".", "\\.")}\\.`),
    `PRIVACY.md does not say it applies to ${minorLine} — re-check its claims against the source, then update the line`
  );
});

test("current security docs distinguish job state, transfers, and write intent", () => {
  const security = read("SECURITY.md");
  const threat = read("docs", "THREAT-MODEL.md");

  assert.match(security, /GEMINI_COMPANION_DATA.*CLAUDE_PLUGIN_DATA.*system-temp/i);
  assert.match(security, /\.omc[/\\]?`? holds transfer snapshots only/i);
  assert.doesNotMatch(security, /Background job state directory isolation \(`?\.omc/i);
  assert.match(threat, /Gemini: only with `--write`\. AGY: possible with or without it/);
  assert.match(threat, /completed or partial `--write` task/);
  assert.doesNotMatch(threat, /review diff itself is unbounded/i);
});

test("entry docs describe the partial write gate and unused AGY sandbox", () => {
  for (const file of ["README.md", "README.zh-TW.md", "plugins/gemini/README.md", "PRIVACY.md"]) {
    const text = read(...file.split("/"));
    assert.match(text, /partial/i, `${file} omits partial write tasks from its current behavior`);
  }

  assert.match(read("README.md"), /plugin deliberately never passes it/);
  assert.match(read("README.zh-TW.md"), /本外掛刻意從不傳入/);
});

test("current comparison and parity docs follow shipped behavior", () => {
  const version = JSON.parse(read("package.json")).version;
  const testCount = [
    ...fs.readdirSync(path.join(ROOT, "tests")).filter((file) => file.endsWith(".test.mjs")),
    ...fs.readdirSync(path.join(ROOT, "bench")).filter((file) => file.endsWith(".test.mjs"))
  ].length;
  const comparison = read("docs", "COMPARISON.md");
  const parity = read("docs", "parity.md");
  const parityZh = read("docs", "parity.zh-TW.md");

  assert.match(comparison, new RegExp(`\\| \\*\\*this project\\*\\* \\|[^\\n]*\\| v${version.replaceAll(".", "\\.")} \\|`));
  assert.match(comparison, new RegExp(`\\| \\*\\*this project\\*\\* \\| 8 \\| \\*\\*6\\*\\* \\| 3 \\| ${testCount} \\|`));
  assert.doesNotMatch(parity, /`\/codex:rescue`[^\n]*\*\*1:1 parity\*\*/);
  assert.match(parity, /agy --conversation/);
  assert.doesNotMatch(parityZh, /`\/codex:rescue`[^\n]*\*\*1:1 對等\*\*/);
  assert.match(parityZh, /agy --conversation/);
});

test("dated playbook indexes require revalidation instead of promising currency", () => {
  for (const index of ["docs/README.md", "docs/README.zh-TW.md"]) {
    const text = read(...index.split("/"));
    assert.doesNotMatch(text, /specs and templates are not superseded|規格與範本未被取代/i);
    assert.match(text, /reverify|重驗/i);
  }
});

// docs/AGY_1.1.2_MACOS_LINUX_VALIDATION.md sat at 249 lines — the largest file in
// docs/ — with zero inbound links from anywhere in the repository, pinning AGY
// 1.1.2 while the plugin was being run against 1.1.13. Nothing was wrong with
// keeping it; what was wrong is that no reader could tell it existed, or that it
// was a dated record rather than the current answer. An index only prevents that
// while it is complete, and an index nobody is forced to update stops being one.
test("the docs index lists every file in docs/", () => {
  const dir = path.join(ROOT, "docs");
  const present = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("README"));
  for (const index of ["docs/README.md", "docs/README.zh-TW.md"]) {
    const text = read(index);
    for (const file of present) {
      assert.ok(text.includes(`(${file})`), `${index} does not list \`${file}\``);
    }
  }
});
