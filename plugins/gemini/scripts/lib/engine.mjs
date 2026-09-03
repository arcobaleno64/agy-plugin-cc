import process from "node:process";
import path from "node:path";

import { createFailureError } from "./failures.mjs";
import { binaryAvailable, resolveBinaryPath } from "./process.mjs";
import { EFFORT_MODEL_MAP, MODEL_ALIASES, VALID_EFFORT_LEVELS } from "./model-map.mjs";
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

// THE AGY FLOOR
// -------------
// This used to be seven capability gates, one per AGY release that changed what
// the plugin could ask for: stdin prompts (1.1.2), the JSON envelope (1.1.8),
// slash-command opt-out (1.1.9), model selection and --add-dir (1.1.10),
// read-only slash commands (1.1.11), stream-json (1.1.12). Each carried a
// fallback for the versions below it.
//
// They are gone, and the reason is not tidiness. Those fallbacks ran only for
// users this project cannot see, and they were the only code the maintainer
// could not exercise locally: the Windows AGY stand-in reports Node's version,
// so six of the suite's eight skipped tests were exactly the old-version paths.
// Least-run code, least-tested code, same code.
//
// One of them was worse than untested. AGY 1.1.5 through 1.1.9 accept --model
// and then ignore it in headless runs, so below that gate the plugin quietly
// ran a model the user did not choose. A declared floor turns that into a
// refusal that names the fix.
//
// 1.1.12 is the highest floor that removes anything and the lowest that removes
// everything: every gate sat at or below it, and no post-1.1.12 behaviour the
// plugin depends on is version-branched (AGY 1.1.20's exit-code change is
// absorbed by failedExit in gemini.mjs, without asking the version).
export const AGY_MINIMUM_VERSION = "1.1.12";
const AGY_MINIMUM_MINOR = 1;
const AGY_MINIMUM_PATCH = 12;

// Three states, not a boolean, because "too old" and "cannot tell" call for
// opposite answers. agyVersionAtLeast returns false for both, which is why the
// floor cannot be expressed with it alone: an unreadable version string would
// be refused exactly like a real 1.1.0.
//
// A version that cannot be parsed does NOT block the run. The alternative makes
// an upstream cosmetic change to `agy --version` an outage for every user at
// once, and the plugin has no way to tell that apart from a genuinely odd
// build. The floor is enforced against versions that are readable and too old,
// never against silence.
// The version has to be the version, not the first pair of numbers on the line.
// An unanchored match reads `antigravity (node 18.2.1)` as AGY 18.2.1 and
// certifies it, and reads `agy 2 (build 1.1)` as 1.1 and refuses a build newer
// than the floor. Anchoring costs nothing on the real output — AGY 1.1.25 prints
// a bare `1.1.25`, and the test stand-in prints `agy 1.1.24` — and turns both
// misreadings into "unreadable", which is the direction that fails open. The
// whole match is handed to agyVersionAtLeast rather than its digits, so a
// prerelease suffix still disqualifies the build.
const AGY_VERSION_AT_START = /^(?:agy|antigravity)?[ \t]*(?:version[ \t]*)?v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/i;

export function agyMeetsFloor(version) {
  const found = AGY_VERSION_AT_START.exec(String(version ?? "").trim());
  if (!found) return "unreadable";
  // A two-segment version is a version, not an unreadable string: "1.1" is
  // decidably below 1.1.12 and must be refused rather than waved through as
  // "could not tell". Padded to X.Y.0, the lowest patch it could mean and
  // therefore the safe reading.
  const candidate = found[1];
  const normalized = /^\d+\.\d+$/.test(candidate) ? candidate + ".0" : candidate;
  return agyVersionAtLeast(normalized, AGY_MINIMUM_MINOR, AGY_MINIMUM_PATCH) ? "ok" : "too-old";
}

// `--engine gemini` is only a way out when gemini can actually run. Under `auto`
// this refusal is reached precisely because gemini had no usable credential, so
// offering it there sends the user to a second failure. Reported by adversarial
// review: the refusal was hiding the other half of the problem.
export function agyFloorRefusal(version, { geminiUsable = true } = {}) {
  return (
    `AGY ${String(version ?? "").trim() || "(unknown)"} is older than this plugin supports. ` +
    `agy-plugin-cc requires AGY ${AGY_MINIMUM_VERSION} or newer: below it, --model and --effort are ` +
    "accepted and then ignored in headless runs, slash commands in a prompt are executed rather than " +
    "read, and there is no JSON envelope to take the response from. Run `agy update`" +
    (geminiUsable
      ? ", or use `--engine gemini`."
      : ". Gemini CLI is not a way out here: it has no usable credential either, which is why routing " +
        "reached AGY at all. Run `gemini` to authenticate it, or set GEMINI_API_KEY. See `/gemini:setup`.")
  );
}

export const AGY_VERSION_UNVERIFIED_NOTICE =
  `Could not read the AGY version, so it was not checked. This plugin needs AGY ${AGY_MINIMUM_VERSION} or newer; ` +
  "if something behaves oddly, run `agy update` first.";

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
    const floor = agyMeetsFloor(version);
    if (floor === "too-old") throw new Error(agyFloorRefusal(version));
    // "unreadable" runs anyway; the caller surfaces the notice once so the user
    // knows the check did not happen rather than believing it passed.
    return { engine: "agy", binary, version, versionUnverified: floor === "unreadable" };
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
    // The floor applies to the engine that will run, not to the way it was
    // chosen. Reaching here means gemini has no usable credential, so an AGY
    // below the floor is not a fallback — it is the only thing left, and running
    // it would silently ignore --model and read slash commands out of the prompt.
    const agyVersion = agyStatus.detail ?? "unknown";
    const agyFloor = agyMeetsFloor(agyVersion);
    if (agyFloor === "too-old") throw new Error(agyFloorRefusal(agyVersion, { geminiUsable: false }));
    return { engine: "agy", binary: agyBinary, version: agyVersion, versionUnverified: agyFloor === "unreadable" };
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
    {
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
    if (outputJson) {
      // stream-json is a superset of what json returns: the same terminal
      // envelope arrives as the final event, preceded by the progress that
      // makes a cut-off run legible. See supportsAgyStreamJson for the gate.
      args.push("--output-format", "stream-json");
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
    } else if (workspaceDir) {
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
  // gemini's `--resume` takes "latest" or an index number, never a session id
  // (`gemini --help`, re-checked on 0.56.0), so the AGY pinning above has no
  // equivalent here and this really does resume whatever gemini saw last.
  // `--session-id` starts a new session rather than reopening one, so it is not a
  // substitute, and an index is a position rather than an identity: it shifts as
  // sessions are created, so `--list-sessions` could name today's index for a
  // thread and not tomorrow's. Nothing available pins a conversation.
  //
  // What that costs depends entirely on whether the turn can write. Read-only, a
  // resume that lands on the wrong conversation costs an answer about the wrong
  // project — the caller compares the returned session id against the thread it
  // resolved and says so afterwards (resolveResumeMismatch in gemini.mjs), and a
  // wrong answer the user is told about is recoverable. Write-capable, the same
  // miss is not: a resumed conversation carries its own workspace, so the edits
  // land in whatever directory that conversation belongs to, and being told after
  // the fact does not bring them back. `--yolo` is already on the argv above.
  //
  // So the unpinnable shape is refused exactly where being wrong writes. This is
  // the same refusal AGY makes forty lines up, narrowed: AGY declines any
  // unpinned resume because it can always pin one, and gemini can never pin one,
  // so declining every resume here would remove the feature instead of securing
  // it.
  if (resumeLast) {
    if (write) {
      throw new Error(
        "Refusing to resume a write-capable gemini turn: `--resume` accepts only \"latest\" or an index number, neither of which identifies a conversation, so this would continue whatever gemini ran last — possibly another project's, which carries its own workspace and would receive the edits. Start a fresh task with `--fresh`, resume without `--write`, or use `--engine agy`, which pins the conversation by id."
      );
    }
    args.push("--resume", "latest");
  }
  if (outputJson) args.push("--output-format", "json");
  return args;
}
