import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_ALIASES,
  AGY_EFFORT_LEVELS,
  normalizeRequestedModel,
  normalizeAgyEffort,
  normalizeAgyRequestedModel,
  mapEffortToModel,
  buildCliArgs,
  detectEngine,
  supportsAgyModelSelection,
  supportsAgySlashCommandOptOut,
  supportsAgyStdinPrompt,
  supportsAgyStructuredOutput
} from "../plugins/gemini/scripts/lib/engine.mjs";

// These two IDs return 404 ModelNotFound on the gemini CLI (verified 0.44.1).
// No alias or effort tier may resolve to them.
const DEAD_MODEL_IDS = ["gemini-3.5-flash", "gemini-3.1-pro"];

test("model aliases resolve to verified-valid IDs", () => {
  assert.equal(normalizeRequestedModel("flash"), "gemini-3-flash-preview");
  assert.equal(normalizeRequestedModel("flash3"), "gemini-3-flash-preview");
  assert.equal(normalizeRequestedModel("pro"), "gemini-3.1-pro-preview");
  assert.equal(normalizeRequestedModel("pro3"), "gemini-3.1-pro-preview");
  assert.equal(normalizeRequestedModel("lite3"), "gemini-3.1-flash-lite");
  assert.equal(normalizeRequestedModel("flash25"), "gemini-2.5-flash");
  assert.equal(normalizeRequestedModel("pro25"), "gemini-2.5-pro");
  assert.equal(normalizeRequestedModel("lite"), "gemini-2.5-flash-lite");
  assert.equal(normalizeRequestedModel("fast"), "gemini-2.5-flash-lite");
});

test("no alias maps to a known-dead 404 model id", () => {
  for (const [alias, id] of MODEL_ALIASES) {
    assert.ok(!DEAD_MODEL_IDS.includes(id), `alias '${alias}' resolves to dead model '${id}'`);
  }
});

test("effort tiers map to verified-valid IDs", () => {
  assert.equal(mapEffortToModel("high"), "gemini-3.1-pro-preview");
  assert.equal(mapEffortToModel("xhigh"), "gemini-3.1-pro-preview");
  assert.equal(mapEffortToModel("medium"), "gemini-3-flash-preview");
  assert.equal(mapEffortToModel("low"), "gemini-3-flash-preview");
  assert.equal(mapEffortToModel("none"), "gemini-2.5-flash-lite");
  assert.equal(mapEffortToModel("minimal"), "gemini-2.5-flash-lite");
  assert.equal(mapEffortToModel(""), null);
  assert.equal(mapEffortToModel(undefined), null);
  for (const tier of ["none", "minimal", "low", "medium", "high", "xhigh"]) {
    assert.ok(!DEAD_MODEL_IDS.includes(mapEffortToModel(tier)), `effort '${tier}' maps to a dead model`);
  }
});

test("unknown / explicit model strings pass through unchanged", () => {
  assert.equal(normalizeRequestedModel("gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(normalizeRequestedModel("some-custom-model"), "some-custom-model");
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel(""), null);
});

test("detectEngine fails closed when agy resolves only to a bare non-.exe path", () => {
  assert.throws(
    () => detectEngine("agy", { resolveBinaryPathImpl: () => "agy.cmd" }),
    /AGY could not be resolved to an executable \.exe path; the plugin refuses to spawn it via the shell to avoid argv injection on Windows\./
  );
});

test("detectEngine fails closed when agy resolves only to an absolute .cmd shim (CVE-2024-27980 angle)", () => {
  // An absolute .cmd path would still re-enter cmd.exe on pre-patch Node even
  // under shell:false, so requireExe must reject it, not just bare names.
  assert.throws(
    () => detectEngine("agy", { resolveBinaryPathImpl: () => (process.platform === "win32" ? "C:\\tools\\agy.cmd" : null) }),
    /AGY could not be resolved to an executable \.exe path/
  );
});

test("AGY stdin prompt capability begins at stable 1.1.2 and fails closed for unknown versions", () => {
  assert.equal(supportsAgyStdinPrompt("1.1.1"), false);
  assert.equal(supportsAgyStdinPrompt("agy 1.1.1"), false);
  assert.equal(supportsAgyStdinPrompt("1.1.2-beta.1"), false);
  assert.equal(supportsAgyStdinPrompt("unknown"), false);
  assert.equal(supportsAgyStdinPrompt("1.1.2"), true);
  assert.equal(supportsAgyStdinPrompt("agy version 1.2.0"), true);
  assert.equal(supportsAgyStdinPrompt("2.0.0"), true);
});

// 1.1.5 through 1.1.9 accept --model/--effort but drop them in headless runs
// (fixed in AGY 1.1.10), so those versions must not be reported as supported.
test("AGY model and effort selection begins at stable 1.1.10", () => {
  assert.equal(supportsAgyModelSelection("1.1.4"), false);
  assert.equal(supportsAgyModelSelection("agy 1.1.5"), false);
  assert.equal(supportsAgyModelSelection("1.1.9"), false);
  assert.equal(supportsAgyModelSelection("1.1.10-beta.1"), false);
  assert.equal(supportsAgyModelSelection("unknown"), false);
  assert.equal(supportsAgyModelSelection("agy 1.1.10"), true);
  assert.equal(supportsAgyModelSelection("1.2.0"), true);
  assert.equal(supportsAgyModelSelection("2.0.0"), true);
});

test("AGY slash-command opt-out begins at stable 1.1.9", () => {
  assert.equal(supportsAgySlashCommandOptOut("1.1.8"), false);
  assert.equal(supportsAgySlashCommandOptOut("1.1.9-rc.1"), false);
  assert.equal(supportsAgySlashCommandOptOut("unknown"), false);
  assert.equal(supportsAgySlashCommandOptOut(null), false);
  assert.equal(supportsAgySlashCommandOptOut("agy 1.1.9"), true);
  assert.equal(supportsAgySlashCommandOptOut("1.1.10"), true);
  assert.equal(supportsAgySlashCommandOptOut("2.0.0"), true);
});

test("AGY requires an exact model ID and preserves safe explicit IDs", () => {
  assert.equal(normalizeAgyRequestedModel("gemini-3.6-flash-high"), "gemini-3.6-flash-high");
  assert.throws(() => normalizeAgyRequestedModel("flash"), /does not accept the Gemini model alias/);
  assert.throws(() => normalizeAgyRequestedModel("lite"), /does not accept the Gemini model alias/);
  assert.throws(() => normalizeAgyRequestedModel("--model"), /Invalid model id/);
});

test("AGY accepts only its documented effort levels", () => {
  assert.deepEqual([...AGY_EFFORT_LEVELS], ["low", "medium", "high"]);
  assert.equal(normalizeAgyEffort("HIGH"), "high");
  assert.throws(() => normalizeAgyEffort("xhigh"), /AGY supports --effort values/);
});

test("agy positional prompt rejects NUL bytes before argv construction", () => {
  assert.throws(
    () => buildCliArgs("agy", { prompt: "hello\0world" }),
    (error) => error.failure?.category === "prompt-too-long" && /NUL/i.test(error.message)
  );
});

test("agy positional prompt rejects prompts above the safe Windows argv limit", () => {
  assert.throws(
    () => buildCliArgs("agy", { prompt: "x".repeat(24_001) }),
    (error) => error.failure?.category === "prompt-too-long" && /24,000|24000/.test(error.message)
  );
});

test("AGY stdin mode omits --print and prompt while preserving execution flags", () => {
  const prompt = "x".repeat(24_001);
  const args = buildCliArgs("agy", {
    prompt,
    useStdin: true,
    write: true,
    timeoutMs: 105_000
  });

  assert.ok(!args.includes("--print"));
  assert.ok(!args.includes(prompt));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--new-project"));
  assert.deepEqual(args.slice(-2), ["--print-timeout", "105s"]);
});

test("AGY forwards an explicit model ID or effort as literal argv", () => {
  const modelArgs = buildCliArgs("agy", { prompt: "hello", useStdin: true, model: "gemini-3.6-flash-high" });
  const effortArgs = buildCliArgs("agy", { prompt: "hello", useStdin: true, effort: "high" });
  assert.deepEqual(modelArgs.slice(0, 2), ["--model", "gemini-3.6-flash-high"]);
  assert.deepEqual(effortArgs.slice(0, 2), ["--effort", "high"]);
  assert.throws(
    () => buildCliArgs("agy", { prompt: "hello", useStdin: true, model: "gemini-3.6-flash-high", effort: "high" }),
    /cannot combine --model with --effort/
  );
});

// AGY 1.1.9+ expands slash commands and skills in print mode. Task prompts are
// raw user text at position 0, so "/clear the cache logic" would run AGY's
// /clear instead of being read as instructions.
test("agy opts out of print-mode slash expansion on 1.1.9 and newer", () => {
  const modern = buildCliArgs("agy", { prompt: "/clear the cache logic", useStdin: true, agyVersion: "1.1.10" });
  assert.ok(modern.includes("--disable-slash-commands"));
});

test("agy omits the slash opt-out where the flag does not exist", () => {
  for (const agyVersion of ["1.1.8", null, "unknown"]) {
    const args = buildCliArgs("agy", { prompt: "hello", useStdin: true, agyVersion });
    assert.ok(
      !args.includes("--disable-slash-commands"),
      `AGY ${agyVersion} predates --disable-slash-commands and must not receive it`
    );
  }
});

test("AGY structured output begins at stable 1.1.8", () => {
  assert.equal(supportsAgyStructuredOutput("1.1.7"), false);
  assert.equal(supportsAgyStructuredOutput("1.1.8-rc.1"), false);
  assert.equal(supportsAgyStructuredOutput("unknown"), false);
  assert.equal(supportsAgyStructuredOutput(null), false);
  assert.equal(supportsAgyStructuredOutput("agy 1.1.8"), true);
  assert.equal(supportsAgyStructuredOutput("1.1.10"), true);
  assert.equal(supportsAgyStructuredOutput("2.0.0"), true);
});

test("agy requests the JSON envelope only where the flag exists", () => {
  const modern = buildCliArgs("agy", { prompt: "hello", useStdin: true, outputJson: true, agyVersion: "1.1.10" });
  assert.deepEqual(modern.slice(modern.indexOf("--output-format"), modern.indexOf("--output-format") + 2), ["--output-format", "json"]);

  for (const agyVersion of ["1.1.7", null, "unknown"]) {
    const args = buildCliArgs("agy", { prompt: "hello", useStdin: true, outputJson: true, agyVersion });
    assert.ok(!args.includes("--output-format"), `AGY ${agyVersion} predates --output-format and must not receive it`);
  }

  // Never requested when the caller did not ask for structured output.
  const plain = buildCliArgs("agy", { prompt: "hello", useStdin: true, agyVersion: "1.1.10" });
  assert.ok(!plain.includes("--output-format"));
});

test("agy write turn adds --new-project so files land in cwd, not agy's scratch dir", () => {
  const args = buildCliArgs("agy", { prompt: "hello", write: true });
  assert.ok(args.includes("--new-project"));
  assert.ok(!args.includes("--continue"));
});

test("agy resumed write turn pins the conversation instead of taking --new-project", () => {
  const args = buildCliArgs("agy", { prompt: "hello", write: true, resumeLast: true, resumeThreadId: "conv-abc" });
  const at = args.indexOf("--conversation");
  assert.ok(at !== -1, "the resolved thread must be named");
  assert.equal(args[at + 1], "conv-abc");
  assert.ok(!args.includes("--new-project"));
});

// `--continue` means "the most recent conversation" in AGY's own store, which
// need not be the thread the caller resolved from this session's tracked jobs —
// a bare `agy` run in another terminal is enough to change what it points at.
// The resumed conversation then brings its own workspace, so a write turn writes
// into that project. It is one word, so it is pinned here rather than trusted to
// stay gone.
test("no agy turn resumes with --continue", () => {
  for (const options of [
    { prompt: "hello", resumeLast: true, resumeThreadId: "conv-abc" },
    { prompt: "hello", write: true, resumeLast: true, resumeThreadId: "conv-abc" },
    { prompt: "hello", write: true, resumeLast: true, resumeThreadId: "conv-abc", agyVersion: "1.1.12" }
  ]) {
    assert.ok(!buildCliArgs("agy", options).includes("--continue"), `--continue returned for ${JSON.stringify(options)}`);
  }
});

// Without an id there is nothing to pin, and the only remaining shape is the one
// that resumes someone else's conversation. Refusing is the fail-closed choice:
// the caller asked to continue a specific thread, not whatever ran last.
test("agy refuses to resume without a conversation id", () => {
  assert.throws(
    () => buildCliArgs("agy", { prompt: "hello", write: true, resumeLast: true }),
    /Cannot resume an AGY conversation without its id/
  );
});

test("agy read-only turn does not bind the session to cwd", () => {
  const args = buildCliArgs("agy", { prompt: "hello" });
  assert.ok(!args.includes("--new-project"));
});

// A read-only AGY turn used to be left unoriented, so the model reported its cwd
// as ~/.gemini/antigravity-cli/scratch and every relative path missed the
// repository — measured on 1.1.10, 2026-08-05. --add-dir orients it without
// --new-project. Both flags do the same job; neither is a permission control.
test("agy read-only turn is oriented on the workspace with --add-dir", () => {
  const args = buildCliArgs("agy", { prompt: "hello", workspaceDir: "C:/repo", agyVersion: "1.1.10" });
  const at = args.indexOf("--add-dir");
  assert.ok(at !== -1, "read-only turn was left unoriented");
  assert.equal(args[at + 1], "C:/repo", "--add-dir must be followed by the workspace path");
  assert.ok(!args.includes("--new-project"), "read-only must not take the write path's flag");
});

test("agy write turn keeps --new-project and does not also add --add-dir", () => {
  const args = buildCliArgs("agy", { prompt: "hello", write: true, workspaceDir: "C:/repo", agyVersion: "1.1.10" });
  assert.ok(args.includes("--new-project"));
  assert.ok(!args.includes("--add-dir"), "--new-project already orients the session");
});

test("agy resumed turn keeps its original workspace rather than being re-oriented", () => {
  const args = buildCliArgs("agy", { prompt: "hello", resumeLast: true, resumeThreadId: "conv-abc", workspaceDir: "C:/repo", agyVersion: "1.1.10" });
  assert.ok(args.includes("--conversation"));
  assert.ok(!args.includes("--add-dir"));
  assert.ok(!args.includes("--new-project"));
});

// Gated at the only version the flag was exercised on. An older AGY keeps the
// previous (unoriented) behavior rather than being handed a flag it may reject.
test("--add-dir is withheld from AGY versions it was not verified on", () => {
  for (const agyVersion of ["1.1.9", "1.1.10-beta.1", "unknown", null]) {
    const args = buildCliArgs("agy", { prompt: "hello", workspaceDir: "C:/repo", agyVersion });
    assert.ok(!args.includes("--add-dir"), `--add-dir leaked to AGY ${agyVersion}`);
  }
});

test("no workspace dir means no --add-dir, whatever the version", () => {
  const args = buildCliArgs("agy", { prompt: "hello", agyVersion: "1.1.10" });
  assert.ok(!args.includes("--add-dir"));
});

// The gemini engine takes its working directory from the spawn, so the flag has
// no counterpart there and must not appear.
test("the gemini engine never receives --add-dir", () => {
  for (const options of [
    { prompt: "hello", useStdin: true, workspaceDir: "C:/repo" },
    { prompt: "hello", useStdin: true, workspaceDir: "C:/repo", write: true }
  ]) {
    assert.ok(!buildCliArgs("gemini", options).includes("--add-dir"));
  }
});

// Measured on AGY 1.1.10 (docs/THREAT-MODEL.md 7.2): headless print mode
// auto-approves edits and shell commands with or without this flag, so it
// granted nothing while reading as a permission bypass. Asserted on both turn
// shapes because a write turn is where it would plausibly be re-added.
test("no agy turn passes --dangerously-skip-permissions", () => {
  for (const options of [
    { prompt: "hello" },
    { prompt: "hello", write: true },
    { prompt: "hello", write: true, resumeLast: true, resumeThreadId: "conv-abc" },
    { prompt: "hello", write: true, useStdin: true, agyVersion: "1.1.10" }
  ]) {
    const args = buildCliArgs("agy", options);
    assert.ok(
      !args.includes("--dangerously-skip-permissions"),
      `flag reappeared for ${JSON.stringify(options)}`
    );
  }
});

// --sandbox restricts what a terminal command may reach, not where anything may
// write — a run with it enabled still wrote outside the workspace through both
// the edit tool and a shell command. Pinned so it is not adopted as a boundary
// on the strength of its name.
test("no agy turn passes --sandbox, which is not a path boundary", () => {
  for (const options of [{ prompt: "hello" }, { prompt: "hello", write: true }]) {
    assert.ok(!buildCliArgs("agy", options).includes("--sandbox"));
  }
});

// The gemini engine is the mirror image of agy: --yolo IS the gate. Measured on
// gemini CLI 0.53.1 (docs/THREAT-MODEL.md 7.2) — without it a headless run is
// offered no write or shell tools at all. Pinned in both directions so neither
// half is dropped by analogy with the agy path.
test("gemini write turn passes --yolo and a read-only turn does not", () => {
  assert.ok(buildCliArgs("gemini", { prompt: "hello", write: true, useStdin: true }).includes("--yolo"));
  assert.ok(!buildCliArgs("gemini", { prompt: "hello", useStdin: true }).includes("--yolo"));
});

// --approval-mode plan does run headless over stdin, but it re-declares
// write_file and edit to the model and injects a planning-workflow prompt.
// Passing nothing leaves those tools undeclared, which is the stronger
// read-only shape. Pinned so plan mode is not adopted for sounding safer.
test("no gemini turn passes --approval-mode, which weakens the read-only shape", () => {
  for (const options of [
    { prompt: "hello", useStdin: true },
    { prompt: "hello", useStdin: true, write: true },
    { prompt: "hello", useStdin: true, outputJson: true },
    { prompt: "hello", useStdin: true, resumeLast: true }
  ]) {
    assert.ok(
      !buildCliArgs("gemini", options).includes("--approval-mode"),
      `flag appeared for ${JSON.stringify(options)}`
    );
  }
});

// --- auto routing ---
// Previously untested. `auto` selected gemini on binary presence alone, so an
// installed-but-unauthenticated gemini (the norm since consumer access ended
// 2026-06-18) routed every command into a guaranteed auth failure while a
// working AGY sat beside it.

const AVAILABLE = { available: true, detail: "1.0.0" };
const MISSING = { available: false };

function stubBinaries({ gemini = MISSING, agy = MISSING } = {}) {
  return (binary) => (String(binary).includes("gemini") ? gemini : agy);
}

test("auto prefers gemini when it is installed and has a credential", () => {
  const info = detectEngine("auto", {
    binaryAvailableImpl: stubBinaries({ gemini: { available: true, detail: "0.52.0" }, agy: AVAILABLE }),
    hasGeminiCredentialsImpl: () => true,
    resolveBinaryPathImpl: () => "/fake/agy.exe"
  });
  assert.equal(info.engine, "gemini");
  assert.equal(info.version, "0.52.0");
});

test("auto falls through to AGY when gemini is installed but unauthenticated", () => {
  const info = detectEngine("auto", {
    binaryAvailableImpl: stubBinaries({ gemini: AVAILABLE, agy: { available: true, detail: "1.1.10" } }),
    hasGeminiCredentialsImpl: () => false,
    resolveBinaryPathImpl: () => "/fake/agy.exe"
  });
  assert.equal(info.engine, "agy");
  assert.equal(info.version, "1.1.10");
});

test("auto reports the credential problem when gemini is the only engine present", () => {
  assert.throws(
    () => detectEngine("auto", {
      binaryAvailableImpl: stubBinaries({ gemini: AVAILABLE, agy: MISSING }),
      hasGeminiCredentialsImpl: () => false,
      resolveBinaryPathImpl: () => "/fake/agy.exe"
    }),
    /installed but has no usable credential/
  );
});

test("auto keeps the plain not-installed message when neither engine is present", () => {
  assert.throws(
    () => detectEngine("auto", {
      binaryAvailableImpl: stubBinaries({}),
      hasGeminiCredentialsImpl: () => false,
      resolveBinaryPathImpl: () => "/fake/agy.exe"
    }),
    /No Gemini or AGY engine found/
  );
});

// An explicit --engine gemini must still work: the user asked for it, and the
// credential check is an auto-routing heuristic, not an authorization gate.
test("explicit gemini selection ignores the credential check", () => {
  const info = detectEngine("gemini", {
    binaryAvailableImpl: stubBinaries({ gemini: AVAILABLE }),
    hasGeminiCredentialsImpl: () => false
  });
  assert.equal(info.engine, "gemini");
});
