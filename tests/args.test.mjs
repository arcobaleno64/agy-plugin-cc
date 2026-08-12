import test from "node:test";
import assert from "node:assert/strict";

import { normalizeArgv, parseArgs, splitRawArgumentString } from "../plugins/gemini/scripts/lib/args.mjs";

// ---------------------------------------------------------------------------
// normalizeArgv, and the caller invariant it depends on.
//
// The defect this answers, found by running the plugin against its own repo:
// `commands/review.md` ran `review --background "$ARGUMENTS"`, so argv was
// ["--background", "--base HEAD~1 --scope branch --engine agy"]. Only a
// single-element argv gets split, so the second element stayed one positional
// that review does not accept — every flag the user typed was dropped and the
// review answered "Nothing to review — branch diff against main has no changes"
// in 1s over a 26-file, 2045-line diff. `setup --json "$ARGUMENTS"` lost
// `--engine` the same way.
//
// Splitting dash-leading tokens anywhere in argv was tried and rejected: in a
// longer argv that token is ambiguous, and guessing broke real input in both
// directions. Those cases are pinned below so the heuristic is not reintroduced.
// The fix is the caller shape, enforced by scripts/verify-contracts.mjs.
// ---------------------------------------------------------------------------

// The review command's real parse config (gemini-companion.mjs handleReviewCommand).
const REVIEW_CONFIG = {
  valueOptions: ["base", "scope", "engine", "model", "effort", "timeout"],
  booleanOptions: ["wait", "background", "deep", "json"]
};

const TASK_CONFIG = {
  valueOptions: ["engine", "model", "effort", "cwd"],
  booleanOptions: ["background", "wait", "write"]
};

test("the command shape a slash command produces parses every flag", () => {
  // What review.md now emits: one word, flags folded in.
  const argv = normalizeArgv(["--base HEAD~1 --scope branch --engine agy --background"]);
  const { options, positionals } = parseArgs(argv, REVIEW_CONFIG);

  assert.equal(options.base, "HEAD~1");
  assert.equal(options.scope, "branch");
  assert.equal(options.engine, "agy");
  assert.equal(options.background, true);
  assert.deepEqual(positionals, [], "review takes no focus text; a leftover here is a lost flag");
});

test("an empty or whitespace-only expansion is no arguments at all", () => {
  assert.deepEqual(normalizeArgv([""]), []);
  assert.deepEqual(normalizeArgv(["   "]), []);
});

test("quotes and escapes inside the expansion survive the split", () => {
  const { options } = parseArgs(normalizeArgv(["--base 'feature/one two' --wait"]), REVIEW_CONFIG);
  assert.equal(options.base, "feature/one two");
  assert.equal(options.wait, true);
  assert.deepEqual(splitRawArgumentString("--base 'feature/one two'"), ["--base", "feature/one two"]);
});

test("a longer argv is passed through untouched", () => {
  // The runtime's own documented CLI form: separate arguments, already correct.
  const argv = ["--background", "--base", "HEAD~1", "--scope", "branch"];
  assert.deepEqual(normalizeArgv(argv), argv);
});

test("prompt text is never re-parsed as flags, whatever it starts with", () => {
  // Splitting these was the rejected alternative. Each line records what that
  // cost: routing hijacked from prose, flags eaten by a `--` inside the text,
  // and an inline value cut in half.
  const prose = "- Investigate why the run uses --engine agy\nand fix it";
  const proseArgv = normalizeArgv([prose, "--write"]);
  assert.deepEqual(proseArgv, [prose, "--write"], "the prompt must reach the engine byte-for-byte");
  const parsedProse = parseArgs(proseArgv, TASK_CONFIG);
  assert.equal(parsedProse.options.engine, undefined, "a sentence must not choose the engine");
  assert.equal(parsedProse.options.write, true);
  assert.deepEqual(parsedProse.positionals, [prose]);

  const dashLed = normalizeArgv(["-- fix the parser", "--write", "--engine", "agy"]);
  const parsedDashLed = parseArgs(dashLed, TASK_CONFIG);
  assert.equal(parsedDashLed.options.write, true, "a `--` inside prompt text must not start passthrough");
  assert.equal(parsedDashLed.options.engine, "agy");

  const inlineValue = normalizeArgv(["--json", "--cwd=/c/My Folder"]);
  assert.equal(parseArgs(inlineValue, TASK_CONFIG).options.cwd, "/c/My Folder");
});
