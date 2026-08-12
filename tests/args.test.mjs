import test from "node:test";
import assert from "node:assert/strict";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";

// ---------------------------------------------------------------------------
// normalizeArgv
//
// The defect this answers, found by running the plugin against its own repo:
// `commands/review.md`'s background flow runs
//   review --background "$ARGUMENTS"
// so argv is ["--background", "--base HEAD~1 --scope branch --engine agy"].
// normalizeArgv only split the raw string when argv had exactly one element, so
// every flag in the second element was discarded, `--base` never reached the
// diff collection, and the review answered "Nothing to review — branch diff
// against main has no changes" in 1s over a 26-file, 2045-line commit. The same
// shape broke `setup --json "$ARGUMENTS"`, which reported on the engine from the
// environment instead of the requested one.
// ---------------------------------------------------------------------------

// The review command's real parse config (gemini-companion.mjs handleReviewCommand).
const REVIEW_CONFIG = {
  valueOptions: ["base", "scope", "engine", "model", "effort", "timeout"],
  booleanOptions: ["wait", "background", "deep", "json"]
};

test("a flag string beside another flag is split, not swallowed as a positional", () => {
  const argv = normalizeArgv(["--background", "--base HEAD~1 --scope branch --engine agy"]);
  const { options, positionals } = parseArgs(argv, REVIEW_CONFIG);

  assert.equal(options.background, true);
  assert.equal(options.base, "HEAD~1");
  assert.equal(options.scope, "branch");
  assert.equal(options.engine, "agy");
  // review takes no focus text: anything left over here is a flag that was lost.
  assert.deepEqual(positionals, []);
});

test("setup keeps the requested engine when --json precedes the expansion", () => {
  const argv = normalizeArgv(["--json", "--engine gemini"]);
  const { options } = parseArgs(argv, { valueOptions: ["engine"], booleanOptions: ["json", "probe-agy"] });

  assert.equal(options.json, true);
  assert.equal(options.engine, "gemini");
});

test("free-text positionals are left intact", () => {
  // A task prompt or review focus arrives the same way and must not be tokenized
  // into flags — this is why splitting cannot be unconditional.
  const argv = normalizeArgv(["--background", "why does the auth flow drop the session id"]);

  assert.deepEqual(argv, ["--background", "why does the auth flow drop the session id"]);
  const { positionals } = parseArgs(argv, REVIEW_CONFIG);
  assert.deepEqual(positionals, ["why does the auth flow drop the session id"]);
});

test("`--` protects dash-leading text from being re-parsed", () => {
  const argv = normalizeArgv(["--background", "--", "--weird literal text"]);

  assert.deepEqual(argv, ["--background", "--", "--weird literal text"]);
  const { options, positionals } = parseArgs(argv, REVIEW_CONFIG);
  assert.equal(options.background, true);
  assert.deepEqual(positionals, ["--weird literal text"]);
});

test("the single-element form still splits, and empty stays empty", () => {
  assert.deepEqual(normalizeArgv(["--base main --wait"]), ["--base", "main", "--wait"]);
  assert.deepEqual(normalizeArgv([""]), []);
  assert.deepEqual(normalizeArgv(["   "]), []);
});

test("already-separate flags are passed through unchanged", () => {
  const argv = ["--background", "--base", "HEAD~1", "--scope", "branch"];
  assert.deepEqual(normalizeArgv(argv), argv);
});

test("quotes inside a nested flag string survive the split", () => {
  const argv = normalizeArgv(["--background", "--base 'feature/one two' --wait"]);
  const { options } = parseArgs(argv, REVIEW_CONFIG);

  assert.equal(options.base, "feature/one two");
  assert.equal(options.wait, true);
  assert.deepEqual(splitRawArgumentString("--base 'feature/one two'"), ["--base", "feature/one two"]);
});
