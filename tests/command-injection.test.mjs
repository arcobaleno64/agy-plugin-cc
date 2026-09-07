import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseTransferArgs } from "../plugins/gemini/scripts/transfer.mjs";

const COMMANDS_DIR = fileURLToPath(new URL("../plugins/gemini/commands", import.meta.url));

function commandFiles() {
  return fs
    .readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, text: fs.readFileSync(path.join(COMMANDS_DIR, name), "utf8") }));
}

// A slash command's `$ARGUMENTS` is substituted into the file as text before the
// model sees it. Anything that then reaches a shell is evaluated there —
// measured: `/gemini:status $(echo INJECTED)` ran the substitution and passed
// `INJECTED` on as the job id. These tests pin the shape that cannot happen
// again, because the mistake is a one-character edit away and looks harmless.

test("no pre-execution block interpolates the user's arguments", () => {
  // A `!`…`` line runs before the model is even consulted, so there is no
  // judgement in the way. This is the shape that was exploitable.
  for (const { name, text } of commandFiles()) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trimStart().startsWith("!`")) continue;
      assert.ok(
        !line.includes("$ARGUMENTS"),
        `${name}: pre-execution block must not contain $ARGUMENTS — found: ${line.trim()}`
      );
    }
  }
});

test("no command interpolates the user's arguments into a shell invocation", () => {
  // Covers the model-executed shape too: a documented `node …"$ARGUMENTS"`
  // command is one the model is being told to run verbatim.
  const offenders = [];
  for (const { name, text } of commandFiles()) {
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.includes("$ARGUMENTS")) continue;
      // Naming the variable in prose is fine; putting it in a command is not.
      if (/\b(node|npm|npx|bash|sh|python)\b[^\n]*\$ARGUMENTS/.test(line)) {
        offenders.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `arguments must never be interpolated into a command:\n${offenders.join("\n")}`);
});

test("every command that still mentions $ARGUMENTS says it must not reach a shell", () => {
  // The text is what the model actually follows, so the warning has to be in
  // the file, not only in this test.
  for (const { name, text } of commandFiles()) {
    if (!text.includes("$ARGUMENTS")) continue;
    assert.match(
      text,
      /never reach a shell|must never reach a shell|never place the argument text/i,
      `${name}: mentions $ARGUMENTS without telling the model to keep it out of a shell`
    );
  }
});

// --- transfer's file-based instructions ------------------------------------

test("--instructions-file supplies the instruction text", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "transfer-instr-")), "instructions.txt");
  fs.writeFileSync(file, "Continue the linter.\n", "utf8");
  const parsed = parseTransferArgs(["--instructions-file", file, "--engine", "agy"]);
  assert.equal(parsed.instructions, "Continue the linter.");
  assert.equal(parsed.engine, "agy");
});

test("shell metacharacters in the file are text, never evaluated", () => {
  // The whole point: this content reached the script without passing a shell.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "transfer-instr-")), "instructions.txt");
  const payload = "Explain $(echo PWNED) and `whoami` and $HOME; rm -rf /";
  fs.writeFileSync(file, payload, "utf8");
  assert.equal(parseTransferArgs(["--instructions-file", file]).instructions, payload);
});

test("giving instructions twice is refused rather than silently merged", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "transfer-instr-")), "instructions.txt");
  fs.writeFileSync(file, "from the file", "utf8");
  assert.throws(
    () => parseTransferArgs(["--instructions-file", file, "also", "positional"]),
    /not both/
  );
});

test("an unreadable instructions file names the path it could not read", () => {
  assert.throws(
    () => parseTransferArgs(["--instructions-file", path.join(os.tmpdir(), "definitely-not-here-9c3d.txt")]),
    /Could not read --instructions-file/
  );
});

test("positional instructions still work when no file is given", () => {
  assert.equal(parseTransferArgs(["carry", "on"]).instructions, "carry on");
});

// A command whose allowlist is missing a flag its own `argument-hint` advertises
// is worse than one with no allowlist at all: the file tells the model to stop
// on any value not in the set, so the flag is refused rather than passed
// through. `/gemini:adversarial-review --engines gemini,agy` was refusable for
// exactly this reason — `--engines` and `--effort` were advertised in the hint,
// documented in the README, accepted by the runtime, and absent from the list.
test("every flag a command advertises is one its allowlist admits", () => {
  const flagsIn = (text) => new Set(text.match(/--[a-z][a-z-]*/g) ?? []);

  for (const { name, text } of commandFiles()) {
    const allowlist = text.split("Every value below must be one you checked")[1];
    if (!allowlist) continue; // Commands that take no flag values carry no list.

    const hint = text.match(/^argument-hint:\s*(.+)$/m)?.[1];
    assert.ok(hint, `${name}: has an allowlist but no argument-hint to check it against`);

    const admitted = flagsIn(allowlist.split("If a value is not in its set")[0]);
    for (const flag of flagsIn(hint)) {
      assert.ok(
        admitted.has(flag),
        `${name}: argument-hint offers ${flag}, but the allowlist does not admit it, so a model following this file must refuse it`
      );
    }
  }
});

// The same injection rule as the slash commands, one layer out. Text a workflow
// receives — a tag name, a release body, an issue title — is written by whoever
// can push a tag or open an issue, and `${{ }}` inside a `run:` body is
// substituted before the shell sees it, so that text becomes shell source. The
// safe shape is `env:`, where the value arrives as data. Applied to every
// workflow rather than the two that currently matter, because the next one is
// written in a hurry.
test("no workflow interpolates an expression into a shell body", () => {
  const dir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  assert.ok(files.length > 0, "there should be workflows to check");

  for (const name of files) {
    const lines = fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const start = lines[i].match(/^(\s*)(?:-\s+)?run:(.*)$/);
      if (!start) continue;

      const indent = start[1].length;
      const body = [start[2]];
      // A block scalar (`run: |`) continues while the following lines are
      // indented past the key, blank lines included.
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() && line.search(/\S/) <= indent) break;
        body.push(line);
      }

      const offending = body.filter((line) => line.includes("${{"));
      assert.deepEqual(
        offending,
        [],
        `${name}: line ${i + 1}'s run body interpolates an expression — pass it through env: instead`
      );
    }
  }
});
