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
const LINKED = ["README.md", "README.zh-TW.md", "SECURITY.md", "PRIVACY.md", "CONTRIBUTING.md"];

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
