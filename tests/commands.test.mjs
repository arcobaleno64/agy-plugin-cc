import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const COMMANDS_DIR = path.join(ROOT, "plugins", "gemini", "commands");

function readCommand(name) {
  return fs.readFileSync(path.join(COMMANDS_DIR, name), "utf8");
}

test("all expected command files are present", () => {
  const expected = [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md",
    "transfer.md"
  ].sort();
  const actual = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(actual, expected);
});

// Claude Code only discovers Markdown command files. A command shipped in any
// other format (e.g. a JSON manifest) is silently skipped by the loader and
// never appears in /plugin, so the directory must hold nothing else.
test("commands directory contains only Markdown command files", () => {
  const stray = fs.readdirSync(COMMANDS_DIR).filter((f) => !f.endsWith(".md"));
  assert.deepEqual(stray, [], `non-Markdown files in commands/ are never loaded as slash commands: ${stray.join(", ")}`);
});

test("review command calls gemini-companion review subcommand", () => {
  const source = readCommand("review.md");
  assert.match(source, /gemini-companion\.mjs.*review/);
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /Do not fix issues/i);
});

test("adversarial-review command references adversarial-review", () => {
  const source = readCommand("adversarial-review.md");
  assert.match(source, /adversarial-review/);
  assert.match(source, /AskUserQuestion/);
});

test("rescue command references gemini-rescue subagent", () => {
  const source = readCommand("rescue.md");
  assert.match(source, /gemini-rescue/);
});

test("setup command exists and has description", () => {
  const source = readCommand("setup.md");
  assert.match(source, /description:/);
});

test("review and adversarial-review use different prompt templates", () => {
  const review = readCommand("review.md");
  const adversarial = readCommand("adversarial-review.md");
  assert.match(review, /review/);
  assert.match(adversarial, /adversarial-review/);
  assert.notEqual(review, adversarial);
});

// --- P0 mirror-parity regression guards ---

test("rescue invokes the subagent via the Agent tool, not a fork", () => {
  const source = readCommand("rescue.md");
  assert.match(source, /allowed-tools:.*\bAgent\b/);
  assert.match(source, /subagent_type:\s*"gemini:gemini-rescue"/);
  assert.doesNotMatch(source, /context:\s*fork/);
});

test("review and adversarial-review are deterministic runners (no fork)", () => {
  for (const name of ["review.md", "adversarial-review.md"]) {
    const source = readCommand(name);
    assert.match(source, /disable-model-invocation:\s*true/, `${name} must disable model invocation`);
    assert.match(source, /Bash\(git:\*\)/, `${name} must allow git`);
    assert.doesNotMatch(source, /context:\s*fork/, `${name} must not use context: fork`);
  }
});

test("adversarial-review calls the companion adversarial-review subcommand directly", () => {
  const source = readCommand("adversarial-review.md");
  assert.match(source, /gemini-companion\.mjs"?\s+adversarial-review/);
  // It must NOT route through the task-only rescue subagent.
  assert.doesNotMatch(source, /gemini-rescue/);
});

// --- P0-2: stdout verbatim must not be contradicted by a fix-selection prompt ---

test("review commands enforce verbatim output without a contradictory fix prompt", () => {
  for (const name of ["review.md", "adversarial-review.md"]) {
    const source = readCommand(name);
    assert.match(source, /verbatim/i, `${name} must keep the verbatim rule`);
    assert.doesNotMatch(source, /ask the user which issues/i, `${name} must not append a fix-selection prompt`);
    assert.doesNotMatch(
      source,
      /which issues, if any, they want fixed/i,
      `${name} must not append a fix-selection prompt`
    );
  }
});

// --- P0-4: engine dependencies follow the selected first-class engine ---

test("setup treats Gemini CLI and AGY as first-class conditional dependencies", () => {
  const source = readCommand("setup.md");
  assert.match(source, /Install Gemini CLI \(Recommended\)/);
  assert.match(source, /--engine agy/, "AGY install must be gated behind --engine agy");
  assert.match(source, /Bash\(curl:\*\)/, "the first-class AGY installer must be allowed to invoke curl");
  assert.match(source, /first-class supported engines/i);
  assert.doesNotMatch(source, /AGY is an optional fallback/i);
});

test("setup authenticates by running gemini, not a nonexistent `gemini login`", () => {
  const source = readCommand("setup.md");
  assert.doesNotMatch(source, /!gemini login/, "must not instruct the nonexistent `!gemini login`");
  assert.doesNotMatch(source, /!agy login/);
  assert.match(source, /OAuth/i);
});

test("transfer is a deterministic runner that calls scripts/transfer.mjs", () => {
  const source = readCommand("transfer.md");
  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /allowed-tools:\s*Bash\(node:\*\)/);
  assert.match(source, /scripts\/transfer\.mjs"?\s+"\$ARGUMENTS"/);
  // The generated launch commands are user-pasted, never executed by Claude.
  assert.match(source, /Do not run the generated commands/i);
});

// --- Shell-safety: $ARGUMENTS must always be quoted when handed to the companion ---
// Unquoted $ARGUMENTS lets the shell word-split, glob, or command-substitute the
// user's raw slash-command text before the companion's parser/validation runs.
test("every command quotes $ARGUMENTS in its companion invocation", () => {
  const files = fs.readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    for (const line of readCommand(file).split(/\r?\n/)) {
      if (line.includes(".mjs") && line.includes("$ARGUMENTS")) {
        assert.match(
          line,
          /"\$ARGUMENTS"/,
          `${file}: $ARGUMENTS must be quoted as "$ARGUMENTS" to avoid shell word-splitting/injection — got: ${line.trim()}`
        );
      }
    }
  }
});
