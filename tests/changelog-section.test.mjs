import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { extractSection } from "../scripts/changelog-section.mjs";

const CHANGELOG = fs.readFileSync(path.join("plugins", "gemini", "CHANGELOG.md"), "utf8");

const SAMPLE = [
  "# Changelog",
  "",
  "## 0.25.0 - Unreleased",
  "",
  "- **BREAKING: AGY 1.1.12 or newer is now required.** Run `agy update`.",
  "",
  "## 0.24.41 - 2026-09-01 - A later release with a longer number",
  "",
  "- Not this one.",
  "",
  "## 0.24.4 - 2026-09-03 - Four things only using it could find",
  "",
  "- The reviewer walkthrough stops competing with the job it waits for.",
  ""
].join("\n");

test("the section for a version is its own body, stopping at the next release", () => {
  const section = extractSection(SAMPLE, "0.25.0");
  assert.match(section.body, /BREAKING: AGY 1\.1\.12/);
  assert.doesNotMatch(section.body, /longer number/, "the next release's heading ends the section");
  assert.equal(section.heading, "0.25.0 - Unreleased");
});

// The heading carries a version, a date and a title, so a prefix match would
// read 0.24.4 out of 0.24.41 — and a release would publish the wrong notes
// without anything looking wrong.
test("a version is matched as a whole token, not as a prefix", () => {
  const section = extractSection(SAMPLE, "0.24.4");
  assert.match(section.body, /reviewer walkthrough/);
  assert.doesNotMatch(section.body, /Not this one/);
});

test("a version with no section is null rather than an empty release note", () => {
  assert.equal(extractSection(SAMPLE, "9.9.9"), null);
});

// The real file is the input in CI. If its heading style ever changes, the
// release notes silently lose their explanation, which is the failure this
// whole script exists to prevent — so assert against the file itself.
test("every released version in the real changelog yields a section", () => {
  const versions = [...CHANGELOG.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map((m) => m[1]);
  assert.ok(versions.length > 5, "expected the changelog to hold several releases");
  for (const version of versions.slice(0, 12)) {
    const section = extractSection(CHANGELOG, version);
    assert.ok(section && section.body.length > 0, `no section body for ${version}`);
  }
});
