#!/usr/bin/env node
// Print one version's CHANGELOG section, for the release notes.
//
// The release page is what most people read about a version, and until now it
// carried only GitHub's generated list of merged PRs — titles, not reasons. The
// reasons are written in the changelog and were reaching nobody. For a breaking
// release that is the whole difference between a user understanding a new
// prerequisite and hitting it.
//
//   node scripts/changelog-section.mjs 0.25.0
//
// Exits non-zero when the section is missing, because `npm run check-version`
// already refuses to release without one: reaching here and finding none means
// the file changed underneath the gate, which is not a case to paper over.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const CHANGELOG = path.join("plugins", "gemini", "CHANGELOG.md");

export function extractSection(markdown, version) {
  const lines = String(markdown).split(/\r?\n/);
  // Headings look like `## 0.24.4 - 2026-09-03 - Four things only using it could
  // find`, so match the version as a whole token rather than a prefix — 0.24.4
  // must not match 0.24.41.
  const escaped = String(version).replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
  const isHeadingFor = (line) => new RegExp(`^##\\s+${escaped}(\\s|$)`).test(line);
  const start = lines.findIndex(isHeadingFor);
  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const nextHeading = rest.findIndex((line) => /^##\s/.test(line));
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).join("\n").trim();
  return { heading: lines[start].replace(/^##\s+/, "").trim(), body };
}

function main(argv) {
  const version = argv[0];
  if (!version) {
    process.stderr.write("usage: node scripts/changelog-section.mjs <version>\n");
    return 2;
  }

  const file = path.resolve(process.cwd(), CHANGELOG);
  if (!fs.existsSync(file)) {
    process.stderr.write(`${CHANGELOG} not found.\n`);
    return 1;
  }

  const section = extractSection(fs.readFileSync(file, "utf8"), version);
  if (!section || !section.body) {
    process.stderr.write(`${CHANGELOG}: no \`## ${version}\` section with content.\n`);
    return 1;
  }

  process.stdout.write(`${section.body}\n`);
  return 0;
}

// Run only when this file is the entry point. `process.argv[1]` is undefined
// under `node -e` and names the test file under `node --test`, so the guard has
// to tolerate both rather than assume a path is there to compare.
if (process.argv[1]?.endsWith("changelog-section.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
