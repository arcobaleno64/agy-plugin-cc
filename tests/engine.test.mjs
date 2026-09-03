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
  agyMeetsFloor,
  agyFloorRefusal,
  AGY_MINIMUM_VERSION
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
    /AGY resolved to a path that is not an executable \.exe; the plugin refuses to spawn it via the shell to avoid argv injection on Windows\./
  );
});

test("detectEngine fails closed when agy resolves only to an absolute .cmd shim (CVE-2024-27980 angle)", () => {
  // An absolute .cmd path would still re-enter cmd.exe on pre-patch Node even
  // under shell:false, so requireExe must reject it, not just bare names.
  assert.throws(
    // Returned on every platform: the point is that requireExe rejects a .cmd,
    // and on POSIX this path is simply not absolute, which fails the same way.
    () => detectEngine("agy", { resolveBinaryPathImpl: () => "C:\\tools\\agy.cmd" }),
    /AGY resolved to a path that is not an executable \.exe/
  );
});

// The seven capability gates became one floor. What the gates encoded is now a
// prerequisite, so the only questions left are: is this version old enough to
// refuse, new enough to run, or unreadable — which is a third answer, not a
// synonym for "too old".
test("the AGY floor refuses the version below it and accepts the floor itself", () => {
  assert.equal(agyMeetsFloor("1.1.11"), "too-old");
  assert.equal(agyMeetsFloor("agy 1.1.9"), "too-old");
  assert.equal(agyMeetsFloor("1.1.2"), "too-old");
  assert.equal(agyMeetsFloor(AGY_MINIMUM_VERSION), "ok");
  assert.equal(agyMeetsFloor("agy version 1.2.0"), "ok");
  assert.equal(agyMeetsFloor("2.0.0"), "ok");
});

// A prerelease of the floor is not the floor: the released behaviour is what was
// measured. Same rule the gates used.
test("a prerelease of the floor version is still too old", () => {
  assert.equal(agyMeetsFloor("1.1.12-rc.1"), "too-old");
  assert.equal(agyMeetsFloor("1.1.12-beta.1"), "too-old");
});

// The asymmetry is deliberate and is the whole reason this returns three states:
// refusing on an unreadable version would turn one upstream change to the shape
// of `agy --version` into an outage for every user at once.
test("an unreadable version is reported as unreadable, never as too old", () => {
  for (const version of ["unknown", "", null, undefined, "antigravity (build 8812)"]) {
    assert.equal(agyMeetsFloor(version), "unreadable", `version ${String(version)}`);
  }
});

// A two-segment version is decidable, so it must be decided. Reported by
// adversarial review: "1.1" fell through the three-segment regex and was waved
// through as unreadable, which let a version unambiguously below the floor run.
test("a two-segment version is refused, not treated as unreadable", () => {
  assert.equal(agyMeetsFloor("1.1"), "too-old");
  assert.equal(agyMeetsFloor("1.0"), "too-old");
  assert.equal(agyMeetsFloor("agy 1.1"), "too-old");
  assert.equal(agyMeetsFloor("1.2"), "ok");
  assert.equal(agyMeetsFloor("2.0"), "ok");
});

// The floor is only worth anything where it is enforced. These assert through
// detectEngine rather than the predicate, because that is the seam every
// command passes and the predicate is not.
test("detectEngine refuses an AGY below the floor and names the fix", () => {
  const absolute = process.platform === "win32" ? "C:/fake/agy.exe" : "/fake/agy";
  for (const version of ["1.1.9", "1.1.11", "1.1"]) {
    assert.throws(
      () => detectEngine("agy", {
        binaryAvailableImpl: () => ({ available: true, detail: version }),
        resolveBinaryPathImpl: () => absolute
      }),
      /older than this plugin supports[\s\S]*agy update/,
      `AGY ${version} must be refused`
    );
  }
});

test("detectEngine runs a supported AGY, and flags an unreadable version instead of refusing", () => {
  const absolute = process.platform === "win32" ? "C:/fake/agy.exe" : "/fake/agy";
  const detect = (detail) => detectEngine("agy", {
    binaryAvailableImpl: () => ({ available: true, detail }),
    resolveBinaryPathImpl: () => absolute
  });

  assert.equal(detect(AGY_MINIMUM_VERSION).versionUnverified, false);
  assert.equal(detect("1.1.24").versionUnverified, false);
  const odd = detect("antigravity (build 8812)");
  assert.equal(odd.engine, "agy");
  assert.equal(odd.versionUnverified, true);
});

// A version string is not a bag of numbers. Both of these were reported by
// adversarial review as misreadings of the unanchored match: the first was
// certified as AGY 18.2.1, the second refused as 1.1. Unreadable is the right
// answer for both, because unreadable fails open and a wrong reading does not.
test("a number in build metadata is not mistaken for the AGY version", () => {
  assert.equal(agyMeetsFloor("antigravity (node 18.2.1)"), "unreadable");
  assert.equal(agyMeetsFloor("agy 2 (build 1.1)"), "unreadable");
  assert.equal(agyMeetsFloor("built from 99.9.9 sources"), "unreadable");
});

// The shapes AGY actually prints. 1.1.25 answers `--version` with a bare
// version; the test stand-in prefixes it. Both must be read, or the floor is
// enforced against nobody.
test("the versions AGY really prints are read, prefix or none", () => {
  assert.equal(agyMeetsFloor("1.1.25"), "ok");
  assert.equal(agyMeetsFloor("agy 1.1.24"), "ok");
  assert.equal(agyMeetsFloor("v1.1.24"), "ok");
  assert.equal(agyMeetsFloor("antigravity 1.1.24"), "ok");
});

// `1.0.x` is unambiguously below the floor even though its patch is a wildcard,
// and a prerelease of the floor itself is not the floor.
test("a wildcard patch is still decidable, and a prerelease is still not the release", () => {
  assert.equal(agyMeetsFloor("1.0.x"), "too-old");
  assert.equal(agyMeetsFloor(`${AGY_MINIMUM_VERSION}-rc.1`), "too-old");
});

// Under auto, this refusal is reached *because* gemini had no usable
// credential, so telling the user to switch to gemini sends them into a second
// failure. The explicit route keeps that suggestion, because there it works.
test("the auto refusal does not offer gemini as the way out", () => {
  const absolute = process.platform === "win32" ? "C:/fake/agy.exe" : "/fake/agy";
  let autoMessage = "";
  try {
    detectEngine("auto", {
      binaryAvailableImpl: (binary) =>
        String(binary).includes("gemini")
          ? { available: true, detail: "0.53.1" }
          : { available: true, detail: "1.1.9" },
      hasGeminiCredentialsImpl: () => false,
      resolveBinaryPathImpl: () => absolute
    });
    assert.fail("a sub-floor AGY under auto must be refused");
  } catch (error) {
    autoMessage = error.message;
  }
  assert.match(autoMessage, /agy update/);
  assert.match(autoMessage, /no usable credential either/);
  assert.doesNotMatch(autoMessage, /or use `--engine gemini`/);

  assert.match(agyFloorRefusal("1.1.9"), /or use `--engine gemini`/);
});

test("the refusal names the detected version, the floor, and the fix", () => {
  const message = agyFloorRefusal("1.1.9");
  assert.match(message, /1\.1\.9/);
  assert.match(message, new RegExp(AGY_MINIMUM_VERSION.replace(/\./g, "\\.")));
  assert.match(message, /agy update/);
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

// These three used to assert a preflight that refused a NUL byte or a prompt
// above 24,000 characters before argv was built. That preflight guarded the
// positional prompt, which the AGY floor retired: the prompt is piped on stdin
// on every path, so the guard protected nothing and only a test could reach it.
// What replaces them is the property that made the guard unnecessary — a prompt
// no argv could carry is never put in argv, whatever is in it.
test("no prompt reaches argv, however long or however hostile", () => {
  for (const prompt of ["hello\u0000world", "x".repeat(24_001), "/quota"]) {
    const args = buildCliArgs("agy", { prompt, outputJson: true });
    assert.ok(!args.includes(prompt), "the prompt itself must not be an argument");
    assert.ok(!args.includes("--print"), "--print would consume the next flag as its prompt");
    assert.ok(
      args.every((arg) => !arg.includes("\u0000")),
      "nothing derived from the prompt may carry a NUL into argv"
    );
    assert.ok(args.includes("--disable-slash-commands"), "a prompt that looks like a slash command stays text");
  }
});

test("AGY stdin mode omits --print and prompt while preserving execution flags", () => {
  const prompt = "x".repeat(24_001);
  const args = buildCliArgs("agy", {
    prompt,
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
  const modelArgs = buildCliArgs("agy", { prompt: "hello", model: "gemini-3.6-flash-high" });
  const effortArgs = buildCliArgs("agy", { prompt: "hello", effort: "high" });
  // By position of the flag, not by position in argv: --disable-slash-commands is
  // unconditional since the version floor, so a slice(0, 2) here was asserting
  // where the flag sits rather than that it carries its value.
  assert.deepEqual(modelArgs.slice(modelArgs.indexOf("--model"), modelArgs.indexOf("--model") + 2), ["--model", "gemini-3.6-flash-high"]);
  assert.deepEqual(effortArgs.slice(effortArgs.indexOf("--effort"), effortArgs.indexOf("--effort") + 2), ["--effort", "high"]);
  assert.throws(
    () => buildCliArgs("agy", { prompt: "hello", model: "gemini-3.6-flash-high", effort: "high" }),
    /cannot combine --model with --effort/
  );
});

// AGY 1.1.9+ expands slash commands and skills in print mode. Task prompts are
// raw user text at position 0, so "/clear the cache logic" would run AGY's
// /clear instead of being read as instructions.
test("agy always opts out of print-mode slash expansion", () => {
  // Unconditional since the floor: a prompt beginning with "/" is user text, and
  // every supported AGY understands the flag that says so. The version is passed
  // here only to prove it no longer decides.
  for (const agyVersion of ["1.1.12", "1.1.24", null, "unknown"]) {
    const args = buildCliArgs("agy", { prompt: "/clear the cache logic", agyVersion });
    assert.ok(args.includes("--disable-slash-commands"), `AGY ${agyVersion} must still receive the opt-out`);
  }
});

test("agy asks for stream-json whenever structured output is requested", () => {
  // stream-json, not json: it is a superset, and it is what makes a run killed
  // mid-answer report how far it got. Unconditional since the floor.
  for (const agyVersion of ["1.1.12", "1.1.24", null, "unknown"]) {
    const args = buildCliArgs("agy", { prompt: "hello", outputJson: true, agyVersion });
    const at = args.indexOf("--output-format");
    assert.deepEqual(args.slice(at, at + 2), ["--output-format", "stream-json"], `AGY ${agyVersion}`);
  }

  // Never requested when the caller did not ask for structured output.
  const plain = buildCliArgs("agy", { prompt: "hello", agyVersion: "1.1.24" });
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

// The same fail-closed choice on the engine that can never pin an id. gemini's
// `--resume` accepts only "latest", so a resumed turn continues whatever gemini
// ran last -- and a resumed conversation carries its own workspace. Read-only
// that costs an answer about the wrong project, which the caller detects
// afterwards and reports (resolveResumeMismatch). Write-capable it costs edits in
// that project's directory, which no after-the-fact notice undoes, so the
// refusal is narrowed to exactly there rather than removing resume entirely.
test("gemini refuses to resume a write-capable turn, and only that", () => {
  assert.throws(
    () => buildCliArgs("gemini", { prompt: "hello", write: true, resumeLast: true }),
    /Refusing to resume a write-capable gemini turn/
  );

  // Read-only resume still works: it is the shape the mismatch notice covers.
  const readOnly = buildCliArgs("gemini", { prompt: "hello", write: false, resumeLast: true });
  assert.deepEqual(readOnly.slice(-2), ["--resume", "latest"]);
  assert.ok(!readOnly.includes("--yolo"), "a read-only resume must not carry the write gate");

  // And a write turn that is not resuming is untouched -- the refusal is about
  // the pair, not about writing.
  assert.ok(buildCliArgs("gemini", { prompt: "hello", write: true }).includes("--yolo"));
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

test("--add-dir orients a read-only turn on every supported AGY", () => {
  // Was gated at 1.1.10, the only version it had been exercised on. The floor is
  // above that, so an unoriented read-only turn — which reported agy's scratch
  // dir as "here" and missed every relative path — is no longer reachable.
  for (const agyVersion of ["1.1.12", "1.1.24", "unknown", null]) {
    const args = buildCliArgs("agy", { prompt: "hello", workspaceDir: "C:/repo", agyVersion });
    assert.ok(args.includes("--add-dir"), `--add-dir missing for AGY ${agyVersion}`);
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
    { prompt: "hello", workspaceDir: "C:/repo" },
    { prompt: "hello", workspaceDir: "C:/repo", write: true }
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
    { prompt: "hello", write: true, agyVersion: "1.1.10" }
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
  assert.ok(buildCliArgs("gemini", { prompt: "hello", write: true }).includes("--yolo"));
  assert.ok(!buildCliArgs("gemini", { prompt: "hello" }).includes("--yolo"));
});

// --approval-mode plan does run headless over stdin, but it re-declares
// write_file and edit to the model and injects a planning-workflow prompt.
// Passing nothing leaves those tools undeclared, which is the stronger
// read-only shape. Pinned so plan mode is not adopted for sounding safer.
test("no gemini turn passes --approval-mode, which weakens the read-only shape", () => {
  for (const options of [
    { prompt: "hello" },
    { prompt: "hello", write: true },
    { prompt: "hello", outputJson: true },
    { prompt: "hello", resumeLast: true }
  ]) {
    assert.ok(
      !buildCliArgs("gemini", options).includes("--approval-mode"),
      `flag appeared for ${JSON.stringify(options)}`
    );
  }
});

// Three different problems used to share one message, and on Windows the only
// one a user was likely to hit — AGY simply not installed — was answered with a
// lecture about argv injection, because path resolution throws before the
// friendly "not available" line is reached. Each case now says its own thing.
test("a missing AGY is reported as missing, not as a security refusal", () => {
  assert.throws(
    () => detectEngine("agy", {
      resolveBinaryPathImpl: () => null,
      binaryAvailableImpl: () => ({ available: false })
    }),
    (error) => {
      assert.match(error.message, /no `agy` binary was found on PATH/);
      assert.match(error.message, /install\.sh/);
      assert.doesNotMatch(error.message, /argv injection/);
      return true;
    }
  );
});

// The security refusal keeps its own case: agy IS installed, and resolves to
// something the plugin will not hand to a shell (CVE-2024-27980).
test("an AGY that resolves to a non-.exe still gets the security refusal", () => {
  assert.throws(
    () => detectEngine("agy", {
      resolveBinaryPathImpl: (_binary, options) => (options?.requireExe ? null : "C:/npm/agy.cmd"),
      binaryAvailableImpl: () => ({ available: true, detail: "1.1.25" })
    }),
    /not an executable \.exe[\s\S]*argv injection/
  );
});

// The resolved path has to be absolute *and*, on Windows, an .exe — both are
// platform judgements, so a Windows-shaped literal here fails the absolute test
// on POSIX and throws the not-an-executable refusal instead of the one under
// test. Shape the fixture like the platform it runs on.
const RESOLVED_AGY_PATH = process.platform === "win32" ? "C:/tools/agy.exe" : "/usr/local/bin/agy";

test("an AGY that resolves but cannot run names the path and what it said", () => {
  assert.throws(
    () => detectEngine("agy", {
      resolveBinaryPathImpl: () => RESOLVED_AGY_PATH,
      binaryAvailableImpl: () => ({ available: false, detail: "exit 127" })
    }),
    new RegExp(`found at ${RESOLVED_AGY_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} but could not run: exit 127`)
  );
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
    binaryAvailableImpl: stubBinaries({ gemini: AVAILABLE, agy: { available: true, detail: "1.1.24" } }),
    hasGeminiCredentialsImpl: () => false,
    resolveBinaryPathImpl: () => "/fake/agy.exe"
  });
  assert.equal(info.engine, "agy");
  assert.equal(info.version, "1.1.24");
});

// The floor belongs to the engine that runs, not to how it was picked. Under
// `auto` an unsupported AGY is not a soft fallback: gemini has already been
// ruled out, so it is the engine, and it must be refused by name rather than run
// with --model silently dropped.
test("auto refuses an unsupported AGY instead of quietly routing to it", () => {
  assert.throws(
    () => detectEngine("auto", {
      binaryAvailableImpl: stubBinaries({ gemini: AVAILABLE, agy: { available: true, detail: "1.1.9" } }),
      hasGeminiCredentialsImpl: () => false,
      resolveBinaryPathImpl: () => "/fake/agy.exe"
    }),
    /1\.1\.9 is older than this plugin supports[\s\S]*agy update/
  );
});

test("auto flags an unreadable AGY version rather than refusing it", () => {
  const info = detectEngine("auto", {
    binaryAvailableImpl: stubBinaries({ gemini: AVAILABLE, agy: { available: true, detail: "antigravity (build 8812)" } }),
    hasGeminiCredentialsImpl: () => false,
    resolveBinaryPathImpl: () => "/fake/agy.exe"
  });
  assert.equal(info.engine, "agy");
  assert.equal(info.versionUnverified, true);
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
