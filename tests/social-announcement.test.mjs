import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractSection } from "../scripts/changelog-section.mjs";
import { LIMITS, buildAnnouncement, extractHighlights, releaseUrl } from "../scripts/build-social-announcement.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SECTION = `- **A short lead-in.** Prose that follows it and should never be posted,
  wrapping across lines the way changelog entries do.

- **A lead-in long enough that its bold run wraps onto the second line of the
  entry.** More prose.

  - **An indented sub-bullet.** Detail, not a headline.

- An entry with no bold lead-in at all, which has no headline to take.

- **Another one.** Done.`;

// The bold run of the most important entry in 0.25.0 — the breaking AGY floor —
// wraps onto a second line, and a line-wise match dropped exactly that one while
// happily collecting the shorter, less important entries. The failure was
// silent: a well-formed post with the headline missing.
test("a lead-in that wraps across lines is still a headline", () => {
  const highlights = extractHighlights(SECTION);
  assert.deepEqual(highlights, [
    "A short lead-in",
    "A lead-in long enough that its bold run wraps onto the second line of the entry",
    "Another one"
  ]);
});

test("indented sub-bullets and unbolded entries contribute no headline", () => {
  const highlights = extractHighlights(SECTION);
  assert.ok(!highlights.some((line) => /sub-bullet/i.test(line)), "a sub-bullet is detail, not a headline");
  assert.ok(!highlights.some((line) => /no bold lead-in/i.test(line)), "an entry with no lead-in is skipped");
});

test("a post that does not fit drops whole headlines, never half a sentence", () => {
  const long = Array.from({ length: 12 }, (_, i) => `- **Headline number ${i} of a release with far too many of them.** Prose.`).join("\n\n");
  const announcement = buildAnnouncement(long, { version: "1.2.3" });

  for (const platform of ["x", "threads"]) {
    const post = announcement[platform];
    assert.ok(post.text.length <= LIMITS[platform], `${platform}: ${post.text.length} > ${LIMITS[platform]}`);
    assert.ok(post.used > 0, `${platform}: at least one headline should survive`);
    assert.ok(post.dropped > 0, `${platform}: this fixture is deliberately too long`);
    for (const headline of announcement.highlights.slice(0, post.used)) {
      assert.ok(post.text.includes(headline), `${platform}: "${headline}" was cut mid-sentence`);
    }
  }
  assert.ok(announcement.threads.used > announcement.x.used, "the longer limit carries more headlines");
});

test("every post carries the canonical release URL", () => {
  const announcement = buildAnnouncement(SECTION, { version: "1.2.3", repo: "owner/repo" });
  assert.equal(announcement.url, "https://github.com/owner/repo/releases/tag/v1.2.3");
  assert.ok(announcement.x.text.endsWith(announcement.url));
  assert.ok(announcement.threads.text.endsWith(announcement.url));
});

test("releaseUrl points at the tag, not at the release list", () => {
  assert.equal(releaseUrl("0.25.0"), "https://github.com/arcobaleno64/agy-plugin-cc/releases/tag/v0.25.0");
});

// The formatter reads this project's real changelog, so its conventions are
// part of the contract: an entry shape that stops producing headlines would
// otherwise be discovered on release day, in public.
test("the changelog's newest section still yields headlines that fit", () => {
  const markdown = fs.readFileSync(path.join(ROOT, "plugins", "gemini", "CHANGELOG.md"), "utf8");
  const version = markdown.match(/^##\s+(\d+\.\d+\.\d+)/m)?.[1];
  assert.ok(version, "the changelog must open with a version heading");

  const section = extractSection(markdown, version);
  const announcement = buildAnnouncement(section.body, { version });

  // One is enough. An earlier version of this asked for three, which reads as a
  // stronger test and is in fact a release blocker: a patch release with one
  // entry would have failed `npm test` inside release.yml, after the tag was
  // already pushed. Measured — a single-entry section failed exactly there in a
  // dry run of this pipeline. What is being checked is that the convention still
  // produces headlines and that they fit, not that a release was large.
  assert.ok(announcement.highlights.length >= 1, `no headlines found in ${version}`);
  assert.ok(announcement.x.text.length <= LIMITS.x);
  assert.ok(announcement.threads.text.length <= LIMITS.threads);
});
