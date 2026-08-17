import process from "node:process";
import path from "node:path";

import { createFailureError } from "./failures.mjs";
import { binaryAvailable, resolveBinaryPath } from "./process.mjs";
import { EFFORT_MODEL_MAP, MODEL_ALIASES, VALID_EFFORT_LEVELS } from "./model-map.mjs";
import { resolveAgyBrainRoot } from "./agy-transcript.mjs";
import { hasGeminiCredentials } from "./gemini-auth.mjs";

export const ENGINE_ENV = "GEMINI_ENGINE";
export const AGY_POSITIONAL_PROMPT_SAFE_LIMIT = 24_000;
export const AGY_EFFORT_LEVELS = new Set(["low", "medium", "high"]);

const AGY_EXECUTABLE_PATH_ERROR =
  "AGY could not be resolved to an executable .exe path; the plugin refuses to spawn it via the shell to avoid argv injection on Windows. Ensure agy is on PATH or use --engine gemini.";

// Model aliases and effort tiers live in model-map.mjs (single source of truth,
// verified against the README table). Re-exported here for existing importers.
export { MODEL_ALIASES, VALID_EFFORT_LEVELS };

export function mapEffortToModel(effort) {
  if (!effort) return null;
  const e = String(effort).trim().toLowerCase();
  return EFFORT_MODEL_MAP.get(e) ?? null;
}

// Model ids ride in argv. Since v0.16.2 the gemini command is normally resolved
// past its `.cmd` shim and spawned with shell:false, so argv is passed literally
// — but resolution can fail (an unrecognized shim, a non-npm install), and the
// fallback is still the shell, where a metacharacter-laden value would be
// reinterpreted by cmd.exe. The prompt is already hardened via stdin; constrain
// the model id to a safe charset so it can never smuggle a shell payload into
// argv on that path. The id must also START with an alphanumeric so a value like
// `--yolo` can never be mistaken for a CLI flag by the gemini binary's own arg
// parser. Every real Gemini model id / alias fits this pattern.
const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function normalizeRequestedModel(model) {
  if (model == null) return null;
  const normalized = String(model).trim().toLowerCase();
  if (!normalized) return null;
  const resolved = MODEL_ALIASES.get(normalized) ?? String(model).trim();
  if (!SAFE_MODEL_ID.test(resolved)) {
    throw new Error(
      `Invalid model id "${String(model).trim()}". Model ids may contain only letters, digits, dot, underscore, and hyphen.`
    );
  }
  return resolved;
}

function resolveAgyExecutablePath({ resolveBinaryPathImpl = resolveBinaryPath } = {}) {
  const resolved = resolveBinaryPathImpl("agy", { requireExe: process.platform === "win32" });
  const isAbsolute = typeof resolved === "string" && path.isAbsolute(resolved);
  const isExecutable = process.platform !== "win32" || path.extname(resolved ?? "").toLowerCase() === ".exe";
  if (!isAbsolute || !isExecutable) {
    throw new Error(AGY_EXECUTABLE_PATH_ERROR);
  }
  return resolved;
}

export function normalizeAgyRequestedModel(model) {
  if (model == null) return null;
  const requested = String(model).trim();
  const normalized = requested.toLowerCase();
  if (!normalized) return null;
  if (MODEL_ALIASES.has(normalized)) {
    throw new Error(
      `AGY does not accept the Gemini model alias "${requested}". Run \`agy models\` and pass an exact AGY model ID, or select --engine gemini.`
    );
  }
  const resolved = requested;
  if (!SAFE_MODEL_ID.test(resolved)) {
    throw new Error(
      `Invalid model id "${requested}". Model ids may contain only letters, digits, dot, underscore, and hyphen.`
    );
  }
  return resolved;
}

export function normalizeAgyEffort(effort) {
  if (effort == null) return null;
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) return null;
  if (!AGY_EFFORT_LEVELS.has(normalized)) {
    throw new Error(`AGY supports --effort values: ${[...AGY_EFFORT_LEVELS].join(", ")}. Use --engine gemini for other effort tiers.`);
  }
  return normalized;
}

// A prerelease build (1.1.10-rc.1) never counts as the released feature.
function agyVersionAtLeast(version, minMinor, minPatch) {
  const match = String(version ?? "").trim().match(/(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/);
  if (!match || match[4]) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major > 1 || (major === 1 && (minor > minMinor || (minor === minMinor && patch >= minPatch)));
}

export function supportsAgyStdinPrompt(version) {
  return agyVersionAtLeast(version, 1, 2);
}

// AGY 1.1.5 accepts --model and --effort, but through 1.1.9 it applied them
// after model configuration had already been initialized, so a headless `-p`
// run silently fell back to the persisted or default model. AGY 1.1.10 fixed
// that; anything older is treated as not supporting selection at all rather
// than reporting a selection the run will not honor.
export function supportsAgyModelSelection(version) {
  return agyVersionAtLeast(version, 1, 10);
}

// AGY 1.1.9 expands slash commands and skills in print mode. Plugin prompts
// carry raw user text at position 0, so a task beginning with "/" would be
// executed as an AGY command instead of read as instructions.
export function supportsAgySlashCommandOptOut(version) {
  return agyVersionAtLeast(version, 1, 9);
}

// AGY 1.1.8 added --output-format json: a stdout envelope carrying the response,
// the conversation id, and a terminal status. Before it, the on-disk transcript
// was the only reliable source for all three.
export function supportsAgyStructuredOutput(version) {
  return agyVersionAtLeast(version, 1, 8);
}

// AGY 1.1.11 answers the read-only slash commands (`/usage`, `/quota`,
// `/credits`, `/model`, `/effort`, `/skills`) in print mode without starting an
// agent turn, spending quota, or leaving a conversation behind. That is what
// makes a non-interactive AGY auth check possible at all: `/quota` needs the
// account to answer, so a SUCCESS envelope proves authentication, and measured
// on 1.1.11 it reports `num_turns: 0` with every token count at zero.
//
// Below 1.1.11 the same input is sent to the model as literal prompt text, so
// the probe would cost a real turn and prove nothing. Gate on the version.
export function supportsAgyReadOnlySlashCommands(version) {
  return agyVersionAtLeast(version, 1, 11);
}

// --add-dir puts a directory in AGY's workspace, which is what makes the model
// treat it as "here". Without it a read-only turn reports its cwd as
// ~/.gemini/antigravity-cli/scratch and every relative path misses — measured on
// 1.1.10, 2026-08-05, alongside --new-project (which orients the same way but is
// reserved for write turns).
//
// Gated at 1.1.10 because that is the only version the flag was exercised on. It
// may well predate that; an unverified lower bound would be a guess, and a guess
// here spawns an unknown flag at an older AGY instead of degrading quietly.
export function supportsAgyWorkspaceDir(version) {
  return agyVersionAtLeast(version, 1, 10);
}

export function detectEngine(requestedEngine = null, options = {}) {
  const {
    hasGeminiCredentialsImpl: hasGeminiCredentialsFn = hasGeminiCredentials,
    binaryAvailableImpl: binaryAvailableFn = binaryAvailable
  } = options;
  const envEngine = process.env[ENGINE_ENV];
  const target = requestedEngine ?? envEngine ?? "auto";
  const normalized = String(target).trim().toLowerCase();

  if (normalized !== "auto" && normalized !== "gemini" && normalized !== "agy") {
    throw new Error(`Unknown engine "${target}". Valid values: auto, gemini, agy.`);
  }

  if (normalized === "agy") {
    const binary = resolveAgyExecutablePath(options);
    const status = binaryAvailableFn(binary, ["--version"]);
    if (!status.available) throw new Error("AGY engine requested but agy binary is not available.");
    const version = status.detail ?? "unknown";
    // Below 1.1.8 the on-disk transcript is the only source for the response,
    // DONE status, and conversation id, so a missing brain dir must fail loud.
    // From 1.1.8 the JSON envelope carries all three and the dir is optional.
    if (!supportsAgyStructuredOutput(version) && !resolveAgyBrainRoot()) {
      throw new Error(
        "AGY engine requested but no transcript brain dir was found. AGY below 1.1.8 has no structured stdout, so the plugin requires the on-disk transcript for the completed response and conversation id. Run `agy` once interactively to initialize it, upgrade to AGY 1.1.8 or newer, or use `--engine gemini`."
      );
    }
    return { engine: "agy", binary, version };
  }

  if (normalized === "gemini") {
    const status = binaryAvailableFn("gemini", ["--version"]);
    if (!status.available) throw new Error("Gemini engine requested but gemini binary is not available.");
    return { engine: "gemini", binary: "gemini", version: status.detail ?? "unknown" };
  }

  // auto: prefer gemini when it is installed AND has a usable credential — the
  // same "ready" notion `/gemini:setup` reports. An installed-but-unauthenticated
  // gemini answers `--version` and then rejects every request, so selecting it on
  // binary presence alone sent users to a guaranteed auth failure while a working
  // AGY sat beside it (common since consumer access ended 2026-06-18).
  //
  // AGY is not a lower tier. Since plugin v0.11.0 it carries the same structured
  // JSON contract, so gemini's remaining edge is only its model aliases and
  // effort-to-model mapping, neither of which applies to an unqualified `auto`.
  const geminiStatus = binaryAvailableFn("gemini", ["--version"]);
  const geminiUsable = geminiStatus.available && hasGeminiCredentialsFn();
  if (geminiUsable) {
    return { engine: "gemini", binary: "gemini", version: geminiStatus.detail ?? "unknown" };
  }

  let agyBinary = null;
  try {
    agyBinary = resolveAgyExecutablePath(options);
  } catch {
    agyBinary = null;
  }
  const agyStatus = agyBinary ? binaryAvailableFn(agyBinary, ["--version"]) : { available: false };
  if (agyStatus.available) {
    return { engine: "agy", binary: agyBinary, version: agyStatus.detail ?? "unknown" };
  }

  // Nothing usable. Distinguish "no engine installed" from "gemini installed but
  // unauthenticated", because the fix differs and the second case used to be
  // reported as a confusing downstream API error.
  if (geminiStatus.available) {
    throw new Error(
      "Gemini CLI is installed but has no usable credential, and no AGY binary was found. Run `gemini` to authenticate, set GEMINI_API_KEY, or install AGY. See `/gemini:setup`."
    );
  }
  throw new Error("No Gemini or AGY engine found. Install either supported engine and retry.");
}

// AGY parses this with Go's duration syntax (its own default prints as `5m0s`),
// so seconds are accepted and are the only unit fine-grained enough to express
// the flush grace window. Rounding up to whole minutes silently defeated it: the
// 105,000 ms window `runGeminiTurn` computes became `2m`, exactly the 120,000 ms
// hard kill it was supposed to land 15 seconds ahead of. AGY was therefore
// SIGKILLed rather than self-terminating, which is why a timed-out structured
// run has empty stdout and no envelope to read.
//
// Verified against AGY 1.1.11 (2026-08-11): `--print-timeout 105s` is accepted.
export function formatAgyTimeout(timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return null;
  return `${Math.max(1, Math.round(timeoutMs / 1000))}s`;
}

function assertAgyPromptSafe(prompt) {
  const value = String(prompt ?? "");
  if (value.includes("\0")) {
    throw createFailureError({
      promptNul: true,
      engine: "agy",
      summary: "AGY prompt contains a NUL byte and cannot be passed as a positional argument.",
      nextStep: "Remove NUL bytes from the prompt or use `--engine gemini`, which sends prompts over stdin."
    });
  }
  if (value.length > AGY_POSITIONAL_PROMPT_SAFE_LIMIT) {
    throw createFailureError({
      promptTooLong: true,
      engine: "agy",
      summary: `AGY positional prompt is ${value.length} characters, above the ${AGY_POSITIONAL_PROMPT_SAFE_LIMIT.toLocaleString("en-US")} character safe limit.`,
      nextStep: "Shorten the prompt or use `--engine gemini`, which sends prompts over stdin."
    });
  }
}

export function buildCliArgs(engine, options = {}) {
  const { prompt = "", model, effort, write = false, resumeLast = false, resumeThreadId = null, outputJson = false, timeoutMs, useStdin = false, agyVersion = null, workspaceDir = null } = options;

  if (engine === "agy") {
    // AGY >=1.1.2 auto-enters print mode when a prompt is piped on stdin; adding
    // --print would consume the following flag as its own prompt argument. Older
    // versions retain the positional form and its Windows argv safety checks.
    const args = [];
    if (!useStdin) {
      assertAgyPromptSafe(prompt);
      args.push("--print", prompt);
    }
    // The prompt is raw user text at position 0, so opt out of AGY's print-mode
    // slash-command and skill expansion wherever the flag exists (1.1.9+).
    if (supportsAgySlashCommandOptOut(agyVersion)) {
      args.push("--disable-slash-commands");
    }
    const agyModel = normalizeAgyRequestedModel(model);
    const agyEffort = normalizeAgyEffort(effort);
    // AGY accepts each flag, but the locally reported model IDs reject the
    // combination (machine-verified on 1.1.5). Refuse it before spawn rather
    // than replacing a useful AGY diagnostic with a transcript-missing failure.
    if (agyModel && agyEffort) {
      throw new Error("AGY cannot combine --model with --effort for its available model IDs. Select a model or an effort level, not both.");
    }
    if (agyModel) args.push("--model", agyModel);
    if (agyEffort) args.push("--effort", agyEffort);
    if (outputJson && supportsAgyStructuredOutput(agyVersion)) {
      args.push("--output-format", "json");
    }
    // No --dangerously-skip-permissions. AGY's headless print mode auto-approves
    // file edits and shell commands with or without it — measured on 1.1.10,
    // 2026-08-05: identical writes with the flag, without it, and with
    // --sandbox added. The flag granted nothing here while being the single
    // clearest "circumvents the permission model" signal in the codebase.
    //
    // --sandbox is deliberately not used either: it restricts what a terminal
    // command may reach (network, .git), not where anything may write. A run
    // with --sandbox wrote outside the workspace through both the edit tool and
    // a shell command. See docs/THREAT-MODEL.md 7.2.
    //
    // --mode plan is not used either, and could not be while --disable-slash-commands
    // is: AGY turns plan mode off whenever slash-command expansion is off, and says
    // so on stderr — "warning: --mode plan has no effect while slash command
    // expansion is disabled" (measured on 1.1.13, 2026-08-17; readable only from
    // 1.1.12, which stopped swallowing startup diagnostics into the log file).
    // Dropping the opt-out to gain it would buy no boundary anyway: plan mode
    // refuses the edit tool and lets a shell command write the same file, exit 0.
    // Both branches below do the same job: tell AGY where "here" is. Without
    // either, a turn reports its cwd as ~/.gemini/antigravity-cli/scratch and
    // every relative path — read or write — lands there instead of in the
    // repository (measured 2026-07-09 and again 2026-08-05).
    //
    // Neither is a permission control, and the difference between them is not
    // read-versus-write. AGY has no read-only mode: with the workspace oriented,
    // the model can edit it, and with the workspace *un*oriented it can still
    // read and write anything by absolute path — measured 2026-08-05, where a
    // run with no workspace flag at all wrote to an absolute path outside its
    // scratch dir. What the unoriented shape actually withheld was the model's
    // knowledge of where the repository is, which stops nothing that a prompt
    // injection carrying an absolute path would do. See docs/THREAT-MODEL.md 7.2.
    if (resumeLast) {
      // A resumed conversation already carries its original workspace, which is
      // exactly why the id has to be pinned. `--continue` means "the most recent
      // conversation" in AGY's own store — not the one the caller checked. The
      // caller resolves a thread from *this* session's tracked jobs and then had
      // no way to say which one it meant, so a bare `agy` run in another terminal,
      // or a task in another project, became the thing that got continued — and
      // it brought its own workspace with it, so `--write` landed in that repo.
      //
      // `--conversation <id>` resumes an existing id (agy --help; only a *fresh*
      // uuid fails, see agy-transcript.mjs TODO-1). Without an id there is nothing
      // to pin and the unsafe shape is the only one left, so refuse instead: the
      // caller asked to continue a specific thread, not whatever ran last.
      if (!resumeThreadId) {
        throw new Error("Cannot resume an AGY conversation without its id. `--continue` resumes AGY's most recent conversation, which may belong to another session or project.");
      }
      args.push("--conversation", resumeThreadId);
    } else if (write) {
      args.push("--new-project");
    } else if (workspaceDir && supportsAgyWorkspaceDir(agyVersion)) {
      // Read-only turns were left unoriented until v0.16.4, which cost them the
      // ability to investigate anything: `/gemini:rescue` without --write is
      // documented for exactly that, and on AGY it was reading a scratch dir.
      args.push("--add-dir", workspaceDir);
    }
    const timeout = formatAgyTimeout(timeoutMs);
    if (timeout) args.push("--print-timeout", timeout);
    return args;
  }

  // gemini — when useStdin is true the caller passes prompt via stdin; omit -p here
  const args = useStdin ? [] : ["-p", prompt];
  if (model) args.push("-m", model);
  // --yolo IS a real gate here, unlike AGY's --dangerously-skip-permissions —
  // measured on gemini CLI 0.53.1, 2026-08-05. Without it a headless run is not
  // offered write_file, edit, or run_shell_command at all, and says so; with it,
  // the same prompt edits files inside and outside the workspace and runs shell
  // commands. See docs/THREAT-MODEL.md 7.2.
  //
  // No --approval-mode plan on the read-only path. It works headless over stdin
  // (measured; the earlier "requires TTY" note was wrong), but it is a *weaker*
  // read-only shape than passing nothing: plan mode re-declares write_file and
  // edit to the model with an amended description and redirects their target
  // into the plans directory, and it injects a planning-workflow system prompt
  // that tells a non-interactive run to write a design document. Passing no
  // approval flag leaves the write tools undeclared, which is the stronger
  // guarantee and the one this plugin wants.
  if (write) {
    args.push("--yolo");
  }
  // gemini's `--resume` takes "latest" or a positional index, never a session id
  // (`gemini --help`, 0.53.1), so the AGY pinning above has no equivalent here and
  // this really does resume whatever gemini saw last. `--session-id` starts a new
  // session rather than reopening one, so it is not a substitute. The caller
  // therefore compares the returned session id against the thread it resolved and
  // says so when they differ — see resolveResumeMismatch in gemini.mjs.
  if (resumeLast) args.push("--resume", "latest");
  if (outputJson) args.push("--output-format", "json");
  return args;
}
