#!/usr/bin/env node
// Turn one version's CHANGELOG section into a short post for X and Threads.
//
//   node scripts/build-social-announcement.mjs 0.25.0 [--json]
//
// It prints text. It posts nothing, holds no credential, and reaches no network.
// That is the whole design of this step, not a limitation of it: this project
// releases a handful of times a year, so automating the posting would buy back
// a couple of minutes annually in exchange for two long-lived social tokens
// living permanently in CI. The formatting is the part worth automating,
// because it is the part that is easy to get wrong under time pressure.
//
// Highlights are not a new convention to maintain. The changelog already marks
// them: every entry opens with a bold lead-in sentence, written when the change
// was fresh, and those lead-ins are exactly the "what changed" list a reader
// outside the project wants. Nothing here paraphrases or summarises — a model
// improvising release copy is how "fixed a null check" becomes "revolutionary
// reliability architecture".
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { extractSection } from "./changelog-section.mjs";

const CHANGELOG = path.join("plugins", "gemini", "CHANGELOG.md");
const DEFAULT_REPO = "arcobaleno64/agy-plugin-cc";

// X allows 280 characters on the free tier's post length, Threads 500. Both
// count a URL at its full length here — no shortener is applied to the text this
// produces, so a limit that fits the raw string fits the posted one.
export const LIMITS = { x: 280, threads: 500 };

export function releaseUrl(version, repo = DEFAULT_REPO) {
  return `https://github.com/${repo}/releases/tag/v${version}`;
}

// The lead-in is the bolded opening of a top-level bullet:
//   - **`auto` no longer calls a refused AGY a missing one.** Long prose...
// It is matched per entry rather than per line, because the longest lead-ins
// wrap — the one that matters most in 0.25.0 is the breaking AGY floor, whose
// bold runs across two lines, and a line-wise match silently dropped exactly
// that one. Sub-bullets are indented and are detail, not headlines, so they are
// not entries. An entry with no bold lead-in is skipped rather than truncated at
// some arbitrary width: a headline nobody wrote is not one to invent.
export function extractHighlights(sectionBody) {
  const entries = [];
  for (const line of String(sectionBody).split(/\r?\n/)) {
    if (/^-\s/.test(line)) entries.push([line]);
    else if (entries.length) entries[entries.length - 1].push(line);
  }

  const highlights = [];
  for (const entry of entries) {
    const bold = entry.join("\n").match(/^-\s+\*\*([\s\S]+?)\*\*/);
    if (!bold) continue;
    highlights.push(
      bold[1]
        .replace(/`/g, "")
        .replace(/\s+/g, " ")
        .replace(/[.:]$/, "")
        .trim()
    );
  }
  return highlights;
}

function assemble({ version, highlights, url, limit, bulletMark }) {
  const header = `agy-plugin-cc v${version}`;
  const footer = `Full changelog:\n${url}`;

  // Drop whole bullets from the end until it fits. Never cut a bullet in half:
  // half a sentence reads as a mistake, and the link is there for the rest.
  for (let count = highlights.length; count > 0; count -= 1) {
    const body = highlights.slice(0, count).map((line) => `${bulletMark} ${line}`).join("\n");
    const text = `${header}\n\n${body}\n\n${footer}`;
    if (text.length <= limit) return { text, used: count, dropped: highlights.length - count };
  }
  const text = `${header}\n\n${footer}`;
  return { text, used: 0, dropped: highlights.length };
}

export function buildAnnouncement(sectionBody, { version, repo = DEFAULT_REPO } = {}) {
  const highlights = extractHighlights(sectionBody);
  const url = releaseUrl(version, repo);
  return {
    version,
    url,
    highlights,
    x: assemble({ version, highlights, url, limit: LIMITS.x, bulletMark: "•" }),
    threads: assemble({ version, highlights, url, limit: LIMITS.threads, bulletMark: "•" })
  };
}

function render(announcement) {
  const lines = [];
  for (const platform of ["x", "threads"]) {
    const post = announcement[platform];
    lines.push(`--- ${platform} (${post.text.length}/${LIMITS[platform]} chars, ${post.used} of ${announcement.highlights.length} highlights) ---`);
    lines.push(post.text);
    lines.push("");
  }
  return lines.join("\n");
}

function main(argv) {
  const version = argv.find((arg) => !arg.startsWith("--"));
  if (!version) {
    process.stderr.write("usage: node scripts/build-social-announcement.mjs <version> [--json]\n");
    return 2;
  }

  const file = path.resolve(process.cwd(), CHANGELOG);
  const section = fs.existsSync(file) ? extractSection(fs.readFileSync(file, "utf8"), version) : null;
  if (!section || !section.body) {
    process.stderr.write(`${CHANGELOG}: no \`## ${version}\` section with content.\n`);
    return 1;
  }

  const repo = process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  const announcement = buildAnnouncement(section.body, { version, repo });
  if (!announcement.highlights.length) {
    process.stderr.write(`No bold lead-ins found in the ${version} section; nothing to announce.\n`);
    return 1;
  }

  process.stdout.write(argv.includes("--json") ? `${JSON.stringify(announcement, null, 2)}\n` : render(announcement));
  return 0;
}

if (process.argv[1]?.endsWith("build-social-announcement.mjs")) {
  process.exitCode = main(process.argv.slice(2));
}
