import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { CELLS } from "./cells.mjs";

// Live cell invocations. Each returns a normalized result; deterministic mode
// never calls these (it replays cassettes). Cells degrade to {ok:false} with a
// reason rather than throwing, so one unavailable tool does not sink the run.
const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(BENCH_DIR, "..");
const GEMINI_COMPANION = path.join(REPO_ROOT, "plugins", "gemini", "scripts", "gemini-companion.mjs");
const SCHEMA = path.join(BENCH_DIR, "review-output.schema.json");
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 180_000);

// codex-companion lives in the installed codex plugin; its path is environment
// specific, so it is opt-in via env. codex.model only needs the `codex` binary.
const CODEX_COMPANION = process.env.BENCH_CODEX_COMPANION || null;

// Which build produced a cassette is the thing that decides, months later,
// whether its numbers still describe the product. A date alone cannot: the
// engines ship faster than the benchmark reruns.
const versionCache = new Map();
function probeVersion(bin, useShell = false) {
  if (versionCache.has(bin)) return versionCache.get(bin);
  const res = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000, shell: useShell });
  const line = (res.stdout ?? "").split("\n")[0].trim();
  const version = res.error || !line ? null : line;
  versionCache.set(bin, version);
  return version;
}

function engineVersionFor(tool) {
  if (tool === "gemini") return probeVersion("gemini", process.platform === "win32");
  if (tool === "codex") return probeVersion("codex", process.platform === "win32");
  if (tool === "agy") {
    const bin = resolveAgyBinary();
    return bin ? probeVersion(bin) : null;
  }
  return null;
}

function extractJsonObject(text) {
  if (text == null) return null;
  const s = String(text);
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeReview(obj) {
  if (!obj || typeof obj !== "object") return null;
  return {
    verdict: typeof obj.verdict === "string" ? obj.verdict : null,
    summary: typeof obj.summary === "string" ? obj.summary : null,
    findings: Array.isArray(obj.findings) ? obj.findings : []
  };
}

function timed(fn) {
  const start = Date.now();
  const out = fn();
  return { ...out, latencyMs: Date.now() - start };
}

function fail(reason) {
  return { ok: false, error: reason, findings: [] };
}

function geminiInnerText(envelope, fallback) {
  // gemini --output-format json wraps the text differently across CLI versions
  // (mirrors lib/gemini.mjs): { response: "..." } | { response: { text } } |
  // { candidates[0].content.parts[0].text } | { text }.
  if (!envelope) return fallback;
  return (
    envelope?.response?.text ??
    (typeof envelope?.response === "string" ? envelope.response : null) ??
    envelope?.candidates?.[0]?.content?.parts?.[0]?.text ??
    envelope?.text ??
    fallback
  );
}

function runGeminiModel(promptText) {
  return timed(() => {
    // gemini 0.45 reads the prompt from stdin when -p has no value; omit -p (as the
    // plugin's buildCliArgs does for useStdin) and deliver the prompt via input.
    const res = spawnSync("gemini", ["--output-format", "json"], {
      input: promptText,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      shell: process.platform === "win32"
    });
    if (res.error) return fail(`gemini spawn: ${res.error.message}`);
    const envelope = extractJsonObject(res.stdout);
    const review = normalizeReview(extractJsonObject(geminiInnerText(envelope, res.stdout)));
    if (!review) return fail(`gemini: could not parse review JSON (${(res.stderr || "").slice(0, 160)})`);
    return { ok: true, ...review, raw: res.stdout?.slice(0, 4000) };
  });
}

let agyBinaryCache;
function resolveAgyBinary() {
  if (agyBinaryCache !== undefined) return agyBinaryCache;
  const finder = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(finder, ["agy"], { encoding: "utf8" });
  const candidates = (res.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const picked = process.platform === "win32"
    ? candidates.find((c) => path.extname(c).toLowerCase() === ".exe")
    : candidates[0];
  agyBinaryCache = picked && path.isAbsolute(picked) ? picked : null;
  return agyBinaryCache;
}

function runAgyModel(promptText, { spawnImpl = spawnSync, resolveBinaryImpl = resolveAgyBinary } = {}) {
  return timed(() => {
    // AGY >=1.1.2 enters print mode from a piped prompt, so --print is omitted:
    // passing it here would make the next flag AGY's positional prompt.
    //
    // No --add-dir. This is the model axis, and AGY's headless print mode
    // auto-approves tools, so leaving the turn unoriented is what keeps the cell
    // comparable to gemini's toolless default: the prompt forbids tools in both,
    // but only one of them is also structurally unable to find the repository.
    const printTimeout = `${Math.max(1, Math.round((TIMEOUT_MS * 0.9) / 1000))}s`;
    // Not `shell: true` like the neighbouring cells: routing agy through cmd.exe
    // never delivered the piped prompt, so the turn sat until the 180s cap and the
    // cell reported ETIMEDOUT. Spawned directly with a resolved path it answers in
    // ~9s. That also matches what the plugin insists on for agy (engine.mjs:51):
    // an absolute .exe, so a planted `agy.bat` on PATH cannot take the call.
    // Seam, for the same reason spawnImpl is one: the binary lookup runs before any
    // of the envelope handling below, so a machine without agy on PATH — every CI
    // runner — exits here and never reaches the behaviour a test means to pin.
    const bin = resolveBinaryImpl();
    if (!bin) return fail("agy: no agy executable on PATH");
    const res = spawnImpl(
      bin,
      ["--disable-slash-commands", "--output-format", "json", "--print-timeout", printTimeout],
      { input: promptText, encoding: "utf8", timeout: TIMEOUT_MS }
    );
    if (res.error) return fail(`agy spawn: ${res.error.message}`);
    // AGY 1.1.8+ answers with one envelope: { conversation_id, status, response, ... }.
    const envelope = extractJsonObject(res.stdout);
    const text = envelope?.response ?? envelope?.result?.response ?? res.stdout;
    const review = normalizeReview(extractJsonObject(text));
    // AGY reports a refused run inside the envelope's `error`, with nothing on
    // stderr — so echoing stderr alone printed `could not parse review JSON ()`
    // and hid the reason. That cost three recording attempts on 2026-08-24, when
    // the real answer was `Individual quota reached ... Resets in 94h2m50s` and the
    // cell looked like a parser or model defect instead of a spent account. Same
    // lesson as the codex branch below, which learned it from its own usage limit.
    if (!review) {
      const reason = envelope?.error ?? envelope?.result?.error ?? res.stderr ?? "";
      return fail(`agy: could not parse review JSON (${String(reason).slice(0, 160)})`);
    }
    return { ok: true, ...review, raw: res.stdout?.slice(0, 4000) };
  });
}

function runCodexModel(promptText) {
  return timed(() => {
    const outFile = path.join(os.tmpdir(), `bench-codex-${Date.now()}.json`);
    const res = spawnSync(
      "codex",
      ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-schema", SCHEMA, "--output-last-message", outFile, "-"],
      { input: promptText, encoding: "utf8", timeout: TIMEOUT_MS, shell: process.platform === "win32" }
    );
    if (res.error) return fail(`codex spawn: ${res.error.message}`);
    let review = null;
    if (fs.existsSync(outFile)) {
      review = normalizeReview(extractJsonObject(fs.readFileSync(outFile, "utf8")));
      try { fs.rmSync(outFile, { force: true }); } catch { /* noop */ }
    }
    if (!review) review = normalizeReview(extractJsonObject(res.stdout));
    // Carry stderr like the gemini and agy branches do. Without it this message
    // was indistinguishable from a parser bug, and on 2026-08-19 it hid the real
    // cause for three runs: exit 1, empty stdout, and "You've hit your usage limit"
    // on stderr. A cell that cannot say why it failed gets diagnosed as the wrong
    // defect.
    if (!review) return fail(`codex: could not parse review JSON (${(res.stderr || "").slice(0, 160)})`);
    return { ok: true, ...review, raw: res.stdout?.slice(0, 4000) };
  });
}

// The companion resolves its engine from GEMINI_ENGINE when no --engine is given,
// and this machine sets GEMINI_ENGINE=agy in ~/.claude/settings.json. So the
// gemini.deep cell — which passed no --engine — spent its whole life recording AGY
// while the cassette was stamped with `gemini --version`. Every cell now pins its
// engine on the command line, and the variable is stripped from the child besides:
// a benchmark whose cells can be redirected by an environment variable is not
// measuring what its column headers say.
export function companionSpawnEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  delete env.GEMINI_ENGINE;
  return env;
}

// A cell may only record a run it can prove came from its own engine. Pinning
// `--engine` on the command line stops the environment redirecting a cell; it does
// not prove the pin was honoured, and the failure it guards against is silent —
// every cassette stays green while carrying another engine's answers. So the
// companion reports the engine it resolved and this compares the two.
//
// Absence is a failure, not a pass. A companion too old to report the field is
// exactly the case that cannot be checked, and treating "no answer" as "the right
// answer" is how the original defect survived.
export function assertExpectedEngine(payload, expected) {
  if (!expected) return null;
  const actual = payload?.engine ?? null;
  if (actual === null) {
    return `companion did not report which engine ran (expected ${expected}); cannot label this cassette`;
  }
  if (actual !== expected) {
    return `cell expects ${expected} but the companion ran ${actual}`;
  }
  return null;
}

// `spawnImpl` exists so the engine check can be tested through the function that
// performs it rather than through the helper it calls. Without the seam, deleting
// the two lines that invoke `assertExpectedEngine` left every test green — the
// helper was correct and unreachable, which is the same shape as the defect this
// whole check exists to prevent.
export function runCompanionReview(companionPath, repoDir, extraArgs, expectEngine = null, { spawnImpl = spawnSync, subcommand = "review" } = {}) {
  return timed(() => {
    if (!companionPath) return fail("companion path not configured");
    const res = spawnImpl(
      process.execPath,
      [companionPath, subcommand, "--scope", "working-tree", "--json", ...extraArgs, "--cwd", repoDir],
      { cwd: repoDir, encoding: "utf8", timeout: TIMEOUT_MS, env: companionSpawnEnv() }
    );
    if (res.error) return fail(`companion spawn: ${res.error.message}`);
    const payload = extractJsonObject(res.stdout);
    const review = normalizeReview(payload?.result);
    if (!review) return fail(`companion: no result in payload (${(res.stderr || "").slice(0, 200)})`);
    const mismatch = assertExpectedEngine(payload, expectEngine);
    if (mismatch) return fail(`companion: ${mismatch}`);
    return { ok: true, ...review, engineObserved: payload?.engine ?? null, raw: res.stdout?.slice(0, 4000) };
  });
}

export function runCell(cell, ctx) {
  const out = dispatchCell(cell, ctx);
  if (!out.ok) return out;
  return { ...out, engineVersion: engineVersionFor(CELLS[cell]?.tool) };
}

function dispatchCell(cell, ctx) {
  switch (cell) {
    case "gemini.model":
      return runGeminiModel(ctx.promptText);
    case "codex.model":
      return runCodexModel(ctx.promptText);
    case "agy.model":
      return runAgyModel(ctx.promptText);
    case "gemini.deep":
      return runCompanionReview(GEMINI_COMPANION, ctx.repoDir, ["--deep", "--engine", "gemini"], "gemini");
    case "codex.native":
      return runCompanionReview(CODEX_COMPANION, ctx.repoDir, []);
    case "agy.deep":
      return runCompanionReview(GEMINI_COMPANION, ctx.repoDir, ["--deep", "--engine", "agy"], "agy");
    case "gemini.adversarial":
      return runCompanionReview(GEMINI_COMPANION, ctx.repoDir, ["--deep", "--engine", "gemini"], "gemini", { subcommand: "adversarial-review" });
    case "agy.adversarial":
      return runCompanionReview(GEMINI_COMPANION, ctx.repoDir, ["--deep", "--engine", "agy"], "agy", { subcommand: "adversarial-review" });
    case "codex.adversarial":
      // codex's `review` maps to its built-in reviewer, whose --json payload has no
      // `result` at all (openai/codex-plugin-cc#679). `adversarial-review` is the
      // codex path that emits schema-shaped findings, which is why the adversarial
      // axis can carry a codex reading while `codex.native` cannot.
      return runCompanionReview(CODEX_COMPANION, ctx.repoDir, [], null, { subcommand: "adversarial-review" });
    default:
      return fail(`unknown cell ${cell}`);
  }
}

export const _internal = { extractJsonObject, normalizeReview, geminiInnerText, companionSpawnEnv, assertExpectedEngine, runCompanionReview, runAgyModel };
