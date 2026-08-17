#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, normalizeArgv } from "./lib/args.mjs";
import { detectEngine, ENGINE_ENV, normalizeAgyEffort, normalizeAgyRequestedModel, normalizeRequestedModel, supportsAgyModelSelection, VALID_EFFORT_LEVELS } from "./lib/engine.mjs";
import { collectReviewContext, describeReviewTarget, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  filterJobsForCurrentSession,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJobs,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderTaskResult,
  renderStoredJobResult,
  renderStoredJobGroupResult,
  renderCancelReport,
  describeTermination,
  renderJobStatusReport,
  renderJobGroupStatusReport,
  renderSetupReport,
  renderStatusReport
} from "./lib/render.mjs";
import {
  runGeminiTurn,
  runGeminiReviewResilient,
  getGeminiAvailability,
  getAgyAvailability,
  getGeminiLoginStatus,
  getAgyLoginStatus,
  probeAgyLogin,
  probeGeminiLogin,
  getGeminiPlanTier,
  hasGeminiCredentials,
  getSessionRuntimeStatus,
  MIN_TURN_TIMEOUT_SECONDS,
  MAX_TURN_TIMEOUT_SECONDS
} from "./lib/gemini.mjs";
import { MODEL_MAP_METADATA, MODEL_ALIAS_ENTRIES } from "./lib/model-map.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SELF_PATH = fileURLToPath(import.meta.url);
// The review output contract. Not read at runtime: the shape is carried to the
// model inside the prompt (`prompts/review.md`, and the reference in
// `skills/gemini-prompting/`) rather than handed to the CLI as a schema file,
// because the gemini engine has no flag that accepts one. AGY 1.1.8 does
// (`--json-schema`); adopting it is an open follow-up, and this is the path it
// would use. Kept deliberately — the file it names exists and is the written
// form of a contract two prompts and the bench scorer all depend on.
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "";

// Deep (agentic) review guidance, appended to the review prompt when `--deep` is
// set. It invites the model to use its read-only tools to inspect repo context
// beyond the diff (dependency manifests, callers, untracked artifacts) — closing
// the gap vs a native agentic reviewer.
//
// A deep review is the one review shape that gets a workspace, because this text
// is an instruction to go and read one. It used to be sent unoriented, which put
// the model's cwd in AGY's scratch directory beside `brain/` — so it could not
// reach the repository and everything it could reach was the user's own
// conversation history. runGeminiReview explains the fix at the flag.
//
// That is workspace binding, not a permission gate: headless mode approves edit
// tools either way and any absolute path is reachable regardless, so the choice
// is about *where* relative paths land, never *whether* a write is possible.
// Whether one happened is measured after the turn (readonly-guard.mjs).
const DEEP_REVIEW_GUIDANCE = [
  "",
  "DEEP REVIEW MODE — look beyond the diff:",
  "Use your available read-only tools to inspect relevant repository context before finalizing.",
  "In particular check: dependency manifests (package.json / lockfiles) for any newly-used import,",
  "the files and callers the change touches, and any untracked files that should not be committed.",
  "Fold context-derived issues (undeclared dependencies, stray/untracked artifacts, broken call sites)",
  "into the SAME JSON findings shape. Do not modify any files."
].join("\n");

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--json] [--probe-agy] [--probe-gemini] [--enable-review-gate|--disable-review-gate]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--deep] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [--engine agy|gemini|auto] [--engines gemini,agy] [--timeout <seconds>] [focus text]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--deep] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [--effort <level>] [--engine agy|gemini|auto] [--timeout <seconds>]",
      "  node scripts/gemini-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model>] [--effort <low|medium|high>] [--engine agy|gemini|auto] [--timeout <seconds>] [prompt]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]",
      "  node scripts/gemini-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

// parseArgs keeps an unrecognized `--flag` as a positional, which is right for a
// parser that cannot know the caller's option table but wrong for the commands
// that read their positionals as free text: `task --help` became the prompt
// "--help", and the model answered it with a plausible-looking AGY tutorial —
// a real billed turn for what is the most natural first thing to type. Same for
// `-h`, and for any mistyped or unsupported flag.
//
// Only a *leading* flag is judged. A `--word` later in a sentence stays prompt
// text, as it is today; rejecting those would turn a mangled prompt into a hard
// error for anyone whose request happens to name a flag.
function describeLeadingFlag(argv, config = {}) {
  const [first] = argv;
  if (!first || first === "-" || first === "--" || !first.startsWith("-")) {
    return null;
  }
  if (first === "--help" || first === "-h") {
    return { help: true };
  }

  const name = first.startsWith("--") ? first.slice(2).split("=")[0] : first.slice(1);
  const known = new Set([
    ...(config.valueOptions ?? []),
    ...(config.booleanOptions ?? []),
    ...Object.keys(config.aliasMap ?? {}),
    "cwd",
    "C"
  ]);
  return known.has(name) ? null : { unknown: first };
}

export function isHelpRequest(argv) {
  return describeLeadingFlag(normalizeArgv(argv))?.help === true;
}

function parseCommandInput(argv, config = {}) {
  const normalized = normalizeArgv(argv);
  const leading = describeLeadingFlag(normalized, config);
  if (leading?.unknown) {
    // Whitespace inside a single flag did not come from anyone's keyboard. A slash
    // command expands into one quoted word, so a double-quoted value *inside* that
    // word closes the quoting early and the shell splits the flag apart:
    // `--base "my branch"` arrives as `--base my` plus `branch ...`. Telling that
    // user to prefix `--` is useless advice — the fix is single quotes, which
    // survive to the runtime's own splitter (lib/args.mjs).
    throw new Error(
      /\s/.test(leading.unknown.trim())
        ? `Unknown option "${leading.unknown}". A double-quoted value closes the slash command's own quoting early, so the shell split this flag apart. Use single quotes instead, e.g. \`--base 'my branch'\`.`
        : `Unknown option "${leading.unknown}". Run \`node scripts/gemini-companion.mjs help\` for usage. If it is prompt text, put \`--\` before it.`
    );
  }

  return parseArgs(normalized, {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

export function buildSetupReport(cwd, actionsTaken = [], options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const geminiAvailabilityFn = options.geminiAvailabilityFn ?? getGeminiAvailability;
  const geminiStatus = geminiAvailabilityFn(cwd);
  // Availability shares the login seam below for the same reason: without it the
  // readiness assertions only hold on a machine that happens to have AGY
  // installed, and pass locally while failing on any runner that does not.
  const agyAvailabilityFn = options.agyAvailabilityFn ?? getAgyAvailability;
  const agyStatus = agyAvailabilityFn();
  // Readiness is computed for the engine the user actually selected (via
  // `--engine` or GEMINI_ENGINE). Resolved here, above the auth seams, because
  // the gemini probe below spends a turn and must not spend it for an engine this
  // run does not report on.
  const requestedEngine = String(options.engine ?? "").trim().toLowerCase();
  // Validate against the same set the runtime resolver accepts (detectEngine).
  // An unrecognized engine must fail the preflight rather than inheriting Gemini
  // readiness — otherwise the next command resolves the same value and throws.
  const engineKnown =
    requestedEngine === "" || requestedEngine === "auto" || requestedEngine === "gemini" || requestedEngine === "agy";
  const agySelected = requestedEngine === "agy";
  // Injected for the same reason as every other input here: read straight from
  // process.env, the readiness assertions below only hold on a machine with no
  // GEMINI_API_KEY exported, so they passed locally and failed on any runner (or
  // developer) that had one.
  const env = options.env ?? process.env;
  const geminiApiKeyInEnv = Boolean(
    String(env.GEMINI_API_KEY ?? "").trim() || String(env.GOOGLE_API_KEY ?? "").trim()
  );
  // Same seam as AGY below: unprobed, this reads the OAuth file; `--probe-gemini`
  // asks the API instead. Unlike `--probe-agy` that is not free, so nothing here
  // probes unless the caller asked — and not even then when `--engine agy` is
  // selected, because AGY readiness ignores `geminiAuth` entirely and every
  // gemini-derived next step below is guarded by `!agySelected`. Billing a turn
  // for an answer this run then discards is the one cost this flag must not have.
  const probeGemini = Boolean(options.probedGemini) && !agySelected;
  // Derived from the gate rather than restating its condition: as two independent
  // expressions they could disagree, and the failure mode of that disagreement is
  // a report saying "not run" for a probe that ran and billed.
  const geminiProbeSkippedForAgy = Boolean(options.probedGemini) && !probeGemini;
  const geminiLoginStatusFn =
    options.geminiLoginStatusFn ?? (probeGemini ? probeGeminiLogin : getGeminiLoginStatus);
  const geminiAuth = geminiLoginStatusFn(cwd);
  // Which credential applied, and whether the OAuth file says it is stale, are
  // questions about the *file* — and under `--probe-gemini` `geminiAuth` is the
  // probe result, where `loggedIn: true` means "the API answered", not "the file
  // is valid". Reading the probe there named `oauth-file` for precisely the
  // 0.53.1 case the probe exists to serve: file deleted, credential in the
  // keychain. The extra read only happens when probing, and it is free and local.
  //
  // Keyed on "did this run probe", not on `geminiAuth.verifiable`: an inconclusive
  // probe reports `verifiable: false`, exactly like a file check, so that field
  // cannot tell the two apart — and reading it there let a timed-out probe erase
  // the expired file underneath it.
  const geminiFileStatusFn = options.geminiFileStatusFn ?? getGeminiLoginStatus;
  const geminiFileAuth = probeGemini ? geminiFileStatusFn(cwd) : geminiAuth;
  // `geminiAuth` reports the OAuth *file* only (unless probed). Readiness must use
  // the full credential check auto-routing uses — env keys and the OS keychain
  // included — or setup reports "not authenticated" for a user whose next command
  // works.
  // Injected for the same reason as the availability probes: without a seam the
  // readiness assertions only hold on a machine that happens to have a gemini
  // credential in its OS keychain, and the interesting cases here are about a
  // credential that resolves but does not work. Forcing it with GEMINI_API_KEY
  // instead would change the answer — an env key deliberately outranks the file.
  // Handed the same env as everything else here: an injected key must count as a
  // credential, or the report names `env-api-key` as the source while reporting
  // that no credential resolved.
  const geminiCredentialedFn = options.geminiCredentialedFn ?? (() => hasGeminiCredentials({ env }));
  const geminiCredentialed = geminiCredentialedFn();
  // Same injection seam as detectEngine/runGeminiTurn: the readiness mapping is
  // the part worth testing, and it should not require a real AGY to reach.
  const agyLoginStatusFn =
    options.agyLoginStatusFn ?? (options.probedAgy ? probeAgyLogin : getAgyLoginStatus);
  const agyAuth = agyLoginStatusFn();
  const geminiPlanTier = getGeminiPlanTier();
  const config = getConfig(workspaceRoot) ?? {};

  // The default/gemini path mirrors upstream: the auto-preferred engine must be
  // installed AND authenticated. Explicit `--engine agy` must NOT inherit Gemini's
  // ready state — it depends on the AGY binary (whose auth cannot be verified
  // non-interactively), so AGY-present is "partial" and AGY-missing is
  // "not-ready". (`requestedEngine` / `agySelected` are resolved above, before the
  // auth seams, so the paid probe can be gated on them.)
  //
  // A credential that resolves is not a credential that works, and this is the one
  // case where we hold proof of the difference: `state: "expired"` means the OAuth
  // file is present and says so. `/gemini:setup --engine gemini` used to answer
  // `ready` with no next steps for an account that returns API_KEY_INVALID on
  // every request, because the keychain still had a (stale) entry and outvoted the
  // file. Positive evidence of staleness now blocks the `ready` claim.
  //
  // Only `expired` — not `missing`. 0.53.1 migrates OAuth into the keychain and
  // deletes the file, so a healthy install also has no file; treating that as
  // evidence would recreate the false "not authenticated" that the keychain check
  // was added to fix. A probe that verified the credential outranks the file —
  // but only a *verified* one: an inconclusive probe used to erase the file
  // evidence too, because the probe result replaced it wholesale.
  const geminiProbeVerified = geminiAuth.state === "verified" && geminiAuth.verifiable === true;
  const geminiStaleFileEvidence =
    !geminiApiKeyInEnv && !geminiProbeVerified && geminiFileAuth.state === "expired";
  // A probe that came back rejected is the strongest evidence available, and it
  // outranks a resolvable keychain entry — the same rule AGY already follows.
  const geminiProbedLoggedOut = geminiAuth.state === "logged-out" && geminiAuth.verifiable === true;
  const geminiReady =
    geminiStatus.available && geminiCredentialed && !geminiStaleFileEvidence && !geminiProbedLoggedOut;
  const agyAvailable = agyStatus.available;
  // `geminiReady: true` beside `geminiAuth.loggedIn: false` reads as a
  // contradiction and was reported as one. Both are correct and they answer
  // different questions: `geminiAuth` inspects the OAuth *file* only, while
  // readiness uses the full credential resolution the CLI itself performs — env
  // API key, that file, then the OS keychain. A user whose 0.53.1 CLI migrated
  // its OAuth into the keychain (and deleted the file) sees an expired-looking
  // `geminiAuth` and a working engine. Name the source that actually satisfied
  // the check so the pair explains itself instead of needing this comment.
  // Resolved in the order hasGeminiCredentials uses, which is the order the CLI
  // itself uses: an env API key wins over the OAuth file, which wins over the
  // keychain. Reporting the file whenever it happens to be valid would name the
  // wrong source for an API-key user. (`geminiApiKeyInEnv` is resolved above, from
  // the injected env, alongside the other readiness inputs.)
  const geminiCredentialSource = !geminiStatus.available
    ? "engine-unavailable"
    : geminiApiKeyInEnv
      ? "env-api-key"
      : geminiFileAuth.loggedIn
        ? "oauth-file"
        : geminiCredentialed
          ? "os-keychain"
          : "none";
  // Backward-compatible alias retained for existing JSON consumers. AGY is a
  // first-class supported engine; "fallback" describes only auto-routing order.
  const agyFallbackAvailable = agyAvailable;
  // `ready` means a verified runtime: installed AND authenticated. Without the
  // probe AGY cannot clear that bar — its auth state is unknown, not bad — so
  // `--engine agy` tops out at `partial`. `setup --probe-agy` asks AGY a
  // question only an authenticated account can answer, at no token cost, and a
  // verified answer promotes AGY to `ready` exactly as an authenticated Gemini
  // CLI is. A probe that comes back logged-out is now a *worse* state than
  // unknown, and must not read as `partial`. An unrecognized engine is never
  // ready.
  const agyVerified = agyAuth.state === "verified";
  const agyLoggedOut = agyAuth.state === "logged-out";
  const ready =
    engineKnown && nodeStatus.available && (agySelected ? agyVerified : geminiReady);
  const readyState = !engineKnown
    ? "not-ready"
    : !nodeStatus.available
      ? "not-ready"
      : agySelected
        ? !agyStatus.available || agyLoggedOut
          ? "not-ready"
          : agyVerified
            ? "ready"
            : "partial"
        : geminiReady
          ? "ready"
          : // An explicitly selected gemini whose probe came back rejected is
            // not-ready, not partial: the same "a verified negative is worse than
            // unknown" rule as AGY. Under `auto` it stays partial, because auto
            // routes to an available AGY when gemini's credential does not work.
            requestedEngine === "gemini" && geminiProbedLoggedOut
            ? "not-ready"
            : agyAvailable
              ? "partial"
              : "not-ready";

  const nextSteps = [];
  if (!engineKnown) {
    nextSteps.push(
      `Engine "${requestedEngine}" is not recognized. Use \`--engine auto\`, \`gemini\`, or \`agy\` (or unset GEMINI_ENGINE).`
    );
  }
  if (agySelected && !agyStatus.available) {
    nextSteps.push(
      "AGY was requested via `--engine agy` but is not installed. Install it with `curl -fsSL https://antigravity.google/cli/install.sh | bash`, or drop `--engine agy` to use the default Gemini CLI."
    );
  }
  if (agySelected && agyStatus.available && agyLoggedOut) {
    nextSteps.push(
      `AGY is installed but not signed in: ${agyAuth.detail} Run \`agy\` once interactively, then re-run \`setup --probe-agy\`.`
    );
  }
  // The old advice here was "run an `--engine agy` command to confirm it is
  // logged in" — i.e. spend a billed turn, and read the answer out of whether it
  // failed. `--probe-agy` answers the same question for nothing. If it already
  // ran and still could not tell, its own detail says why (too old an AGY, or a
  // probe that did not answer) and repeating the suggestion would be a loop.
  if (agySelected && agyStatus.available && !agyVerified && !agyLoggedOut) {
    nextSteps.push(
      options.probedAgy
        ? agyAuth.detail
        : "AGY is installed, but its authentication state has not been checked. Run `setup --probe-agy` to verify it without spending a turn."
    );
  }
  if (!geminiStatus.available && !agyStatus.available) {
    nextSteps.push(
      "Install at least one supported engine: Gemini CLI with `npm install -g @google/gemini-cli`, or AGY with `curl -fsSL https://antigravity.google/cli/install.sh | bash`."
    );
  }
  if (!agySelected && geminiStatus.available && !geminiCredentialed) {
    nextSteps.push("Run `gemini` once to authenticate, or set GEMINI_API_KEY.");
  }
  // Both of the gemini "resolvable but does not work" cases. Without these the
  // report was silent: `readyState` said `ready` and `nextSteps` was empty while
  // `geminiAuth.detail` said the token had expired days earlier.
  // Quotes the *file* status, and only offers the probe when one has not already
  // answered. Reading `geminiAuth` here produced "the OAuth file says it is stale:
  // Gemini CLI rejected the probe…" followed by advice to run the probe that had
  // just run — the same confusion of the two sources as the source naming above.
  // A verified-rejected probe is strictly stronger evidence and its own step names
  // the identical fix, so it stands alone rather than being said twice.
  if (!agySelected && geminiStaleFileEvidence && !geminiProbedLoggedOut) {
    const probeOffer = probeGemini
      ? ""
      : " If a keychain credential is meant to be in use instead, `setup --probe-gemini` checks it against the API — that one spends a turn when the credential works, unlike `--probe-agy`.";
    nextSteps.push(
      `Gemini CLI has a stored credential, but the OAuth file says it is stale: ${geminiFileAuth.detail}${probeOffer}`
    );
  }
  if (!agySelected && geminiProbedLoggedOut) {
    nextSteps.push(geminiAuth.detail);
  }
  // A probe that could not decide still costs money, and this was the one place
  // the flag could hide a spend: `unknown` pushed nothing, so the report read as
  // if no probe had run. The AGY branch above already discloses its own
  // inconclusive probe; its detail says whether the request may have been billed.
  if (!agySelected && probeGemini && geminiAuth.state === "unknown") {
    nextSteps.push(geminiAuth.detail);
  }
  // Skipping the probe is the right call (its answer would be discarded), but a
  // silently ignored flag is how a user concludes the credential was checked.
  if (geminiProbeSkippedForAgy) {
    nextSteps.push(
      "`--probe-gemini` was not run: `--engine agy` was selected, so the Gemini credential is not what this report describes, and the probe spends a turn. Drop `--engine agy` to check it."
    );
  }
  if (!agySelected && !geminiStatus.available && agyAvailable) {
    nextSteps.push(
      "Gemini CLI is unavailable; AGY is installed as a supported engine and auto routing can select it. Use `--engine agy` explicitly to confirm its authentication state, or install Gemini CLI to restore the preferred auto-routing candidate."
    );
  }

  // Personal (free) plan EOL: gemini CLI free access *ended* 2026-06-18. Past
  // tense on purpose — this read "ends 2026-06-18" for two months after the date,
  // telling a personal-plan user a deadline was still ahead of them while the same
  // repository's other references had already been corrected to "ended".
  // Enterprise / Code Assist tiers are unaffected; an unknown tier stays silent.
  if (geminiPlanTier.tier === "personal") {
    nextSteps.push(
      "Heads-up: Gemini personal-plan free CLI access ended 2026-06-18. To keep the gemini engine, upgrade to Gemini Code Assist Standard/Enterprise; otherwise route through AGY (`--engine agy`), which returns its response in a native JSON envelope on AGY 1.1.8+ (older AGY falls back to reading its on-disk transcript, because `agy --print` did not pipe output — upstream google-gemini/gemini-cli#27466)."
    );
  }

  // Surface model-alias provenance so preview-channel drift is visible: how many
  // aliases resolve to *-preview IDs (which can change) and when they were last
  // verified. Defensive in case the alias table is ever malformed.
  const modelAliasCount = Array.isArray(MODEL_ALIAS_ENTRIES) ? MODEL_ALIAS_ENTRIES.length : 0;
  const previewAliasCount = Array.isArray(MODEL_ALIAS_ENTRIES)
    ? MODEL_ALIAS_ENTRIES.filter((entry) => entry.preview).length
    : 0;

  return {
    ready,
    readyState,
    requestedEngine: requestedEngine || "auto",
    geminiReady,
    geminiCredentialSource,
    agyAvailable,
    agyFallbackAvailable,
    geminiPlanTier,
    node: nodeStatus,
    npm: npmStatus,
    gemini: geminiStatus,
    geminiAuth,
    agy: agyStatus,
    agyAuth,
    // Hand over the probes this report already took. Re-probing would spend two
    // more spawns and let one payload disagree with itself: the readiness fields
    // would describe the injected engines while sessionRuntime described whatever
    // happens to be installed on the machine running the test.
    sessionRuntime: getSessionRuntimeStatus({
      requestedEngine,
      // Same env the readiness fields were computed from, for the same reason the
      // availability probes are handed over: one payload must not describe an
      // injected environment in one field and the ambient machine in another.
      env,
      geminiAvailabilityFn: () => geminiStatus,
      agyAvailabilityFn: () => agyStatus
    }),
    reviewGateEnabled: config.stopReviewGateEnabled ?? false,
    modelAliases: {
      total: modelAliasCount,
      preview: previewAliasCount,
      lastVerified: MODEL_MAP_METADATA?.lastVerified ?? "unknown"
    },
    actionsTaken,
    nextSteps
  };
}

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "probe-agy", "probe-gemini"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Honor the engine the user routes to (flag wins over GEMINI_ENGINE) so the
  // readiness verdict matches the engine the next command will actually use.
  const requestedEngine = options.engine ?? process.env[ENGINE_ENV];
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGateEnabled", true);
    actionsTaken.push("Review gate enabled.");
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGateEnabled", false);
    actionsTaken.push("Review gate disabled.");
  }

  const finalReport = buildSetupReport(cwd, actionsTaken, {
    engine: requestedEngine,
    probedAgy: Boolean(options["probe-agy"]),
    probedGemini: Boolean(options["probe-gemini"])
  });
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function isActiveJobSnapshot(snapshot) {
  return (snapshot.jobs ?? [snapshot.job]).some((job) => isActiveJobStatus(job.status));
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobSnapshot(snapshot) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobSnapshot(snapshot),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  // Only consider jobs from the current Claude session so a resume never jumps
  // into another session's (or another project's) thread. Untagged jobs are
  // excluded here too, unlike the listing paths: showing a job the user can see
  // and cancel is one thing, silently continuing its conversation is another.
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(listJobs(workspaceRoot), { includeUnattributed: false })
  ).filter((job) => job.id !== options.excludeJobId);
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }

  const trackedTask = jobs.find((job) => job.jobClass === "task" && job.status === "completed" && job.threadId);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  return null;
}

export function buildReviewPrompt(request) {
  const templateName = request.templateName ?? "adversarial-review";
  // Resolve the review target from the caller's --base/--scope so the user's
  // selection actually reaches the diff collection. (Re-resolving with empty
  // options here would silently discard --base/--scope.)
  const target = request.target ?? resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const context = collectReviewContext(request.cwd, target);
  if (context.isEmpty) return { context, prompt: null };

  const template = loadPromptTemplate(ROOT_DIR, templateName);
  const basePrompt = interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: request.focusText || "No extra focus provided.",
    REVIEW_INPUT: context.content
  });
  return {
    context,
    prompt: request.deep ? `${basePrompt}\n${DEEP_REVIEW_GUIDANCE}` : basePrompt
  };
}

// A review whose input was truncated has not seen the whole change, so it must
// not report `approve` — the verdict is what a reader, `--json` consumer and the
// stop-review gate all take as "this code was looked at", and a banner they may
// not read cannot carry that. The schema's enum has only `approve` and
// `needs-attention`, so the conservative value stands in; the model's own
// verdict is preserved rather than discarded.
//
// `parsedResult` is mutated in place on purpose: it is the same object behind
// `payload.result` and the rendered output, so correcting it once is what keeps
// those two from disagreeing.
function buildTruncationReport(context, parsedResult) {
  if (!context?.truncated) return null;

  const report = {
    truncated: true,
    truncatedFiles: context.truncatedFiles ?? [],
    omittedFiles: context.omittedFiles ?? []
  };
  if (parsedResult?.verdict === "approve") {
    parsedResult.verdict = "needs-attention";
    report.modelVerdict = "approve";
    report.verdictDowngraded = true;
  }
  return report;
}

function renderTruncationBanner(truncation) {
  if (!truncation) return "";

  const lines = ["> ⚠️ Review input was truncated — this verdict does not cover the whole change."];
  if (truncation.truncatedFiles.length > 0) {
    lines.push(`> Cut short: ${truncation.truncatedFiles.join(", ")}`);
  }
  if (truncation.omittedFiles.length > 0) {
    lines.push(`> Not sent at all: ${truncation.omittedFiles.join(", ")}`);
  }
  if (truncation.verdictDowngraded) {
    lines.push("> Gemini reported `approve`; recorded as `needs-attention` because the review was partial.");
  }
  return `${lines.join("\n")}\n\n`;
}

async function executeReviewRun(request) {
  const reviewName = request.reviewName ?? "Adversarial Review";
  const templateName = request.templateName ?? "adversarial-review";
  const { context, prompt } = request.preparedReview ?? buildReviewPrompt(request);

  // Nothing-to-review guard: if the resolved target has no changes, short-circuit
  // instead of asking Gemini to review an empty diff (which it rubber-stamps as
  // "approved"). This matters most for a detached --background review, where the
  // worker re-resolves the diff at run time and a now-clean tree would otherwise
  // persist a vacuous approve that only surfaces at /gemini:result.
  if (context.isEmpty) {
    const targetLabel = context.target?.label ?? "the requested scope";
    // The message keeps the plain label — it is also the job summary, read in
    // listings — while the Target line below carries the provenance, which is what
    // separates "the repository really is clean" from "that is not the scope I
    // meant".
    const message = `Nothing to review — ${targetLabel} has no changes.`;
    return {
      exitStatus: 0,
      threadId: null,
      turnId: null,
      engine: null,
      payload: {
        review: reviewName,
        target: context.target,
        empty: true,
        gemini: null,
        result: null
      },
      rendered: `# Gemini ${reviewName}\n\nTarget: ${describeReviewTarget(context.target)}\n\n${message}\n`,
      summary: message,
      jobTitle: `Gemini ${reviewName}`,
      jobClass: "review",
      targetLabel
    };
  }

  const result = await runGeminiReviewResilient(request.cwd, {
    prompt,
    model: request.model,
    effort: request.effort,
    engine: request.engine,
    isAdversarial: templateName === "adversarial-review",
    // Decides whether the engine gets a workspace, so it must be the same flag
    // that appended the deep-review guidance to the prompt — a model told to go
    // and read the repository with no repository to read is the shape this fixes.
    deep: Boolean(request.deep),
    timeoutSeconds: request.timeoutSeconds ?? null,
    onProgress: request.onProgress
  });

  const parsed = result.reviewJson
    ? { parsed: result.reviewJson, rawOutput: result.reviewText, parseError: null, failure: result.failure ?? null }
    : { parsed: null, rawOutput: result.reviewText, parseError: "Could not parse structured JSON from review output.", failure: result.failure ?? null };

  const truncation = buildTruncationReport(context, parsed.parsed);

  const payload = {
    review: reviewName,
    target: context.target,
    gemini: { status: result.status, stdout: result.reviewText, stderr: result.stderr ?? "" },
    result: parsed.parsed,
    ...(truncation ? { truncation } : {}),
    ...(result.readOnlyNotice ? { readOnlyNotice: result.readOnlyNotice, readOnlyWrites: result.readOnlyWrites } : {}),
    ...(result.failure ? { failure: result.failure } : {})
  };

  const fallbackBanner = result.modelFallback ? `> ⚠️ ${result.modelFallback}\n\n` : "";
  // A review that changed the tree is not a review finding — it is the review
  // itself having done something nobody asked for, so it goes above everything.
  const writeBanner = result.readOnlyNotice ? `> ⚠️ ${result.readOnlyNotice}\n\n` : "";

  return {
    exitStatus: result.status,
    threadId: null,
    turnId: null,
    engine: result.engine ?? null,
    payload,
    rendered: writeBanner + fallbackBanner + renderTruncationBanner(truncation) + renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: describeReviewTarget(context.target),
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? "Review completed.",
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    // Stays the plain label: this one is stored on the job record and shown inline
    // in job listings, where an existing consumer may already be printing it inside
    // a sentence. The provenance goes in the rendered Target line above, which is
    // the place a reader looks when the scope surprised them.
    targetLabel: context.target?.label ?? "",
    ...(result.status !== 0 && result.failure ? { failure: result.failure } : {})
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);

  let resumeLast = false;
  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, { excludeJobId: request.jobId });
    if (!latestThread) {
      throw new Error("No previous Gemini task thread found.");
    }
    resumeLast = true;
    // The id is the point of the lookup. It used to be resolved, checked, and
    // then dropped — the engine was handed "continue the most recent
    // conversation", which is not the same thread and, on AGY, is not even
    // scoped to this project.
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeLast) {
    throw new Error("Provide a prompt or use --resume-last.");
  }

  const result = await runGeminiTurn(workspaceRoot, {
    prompt: request.prompt,
    model: request.model,
    effort: request.effort,
    engine: request.engine,
    write: request.write,
    resumeLast,
    resumeThreadId,
    timeoutSeconds: request.timeoutSeconds ?? null,
    onProgress: request.onProgress
  });

  const rawOutput = result.finalMessage ?? "";
  const failureMessage = result.stderr ?? "";
  const failure = result.failure ?? null;
  const taskMetadata = buildTaskRunMetadata({ prompt: request.prompt, resumeLast: request.resumeLast });

  const fallbackBanner = result.modelFallback ? `${result.modelFallback}\n\n` : "";
  const rendered = fallbackBanner + renderTaskResult(
    { rawOutput, failureMessage, reasoningSummary: result.reasoningSummary, failure },
    { title: taskMetadata.title, jobId: request.jobId ?? null, write: Boolean(request.write) }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId ?? null,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary,
    ...(result.readOnlyNotice ? { readOnlyNotice: result.readOnlyNotice, readOnlyWrites: result.readOnlyWrites } : {}),
    ...(result.resumeNotice ? { resumeNotice: result.resumeNotice, resumeExpectedThreadId: result.resumeExpectedThreadId } : {}),
    ...(failure ? { failure } : {})
  };

  // A read-only turn that wrote, and a resume that landed on another thread, are
  // the two things here the user cannot afford to scroll past, so they go above
  // the output rather than into the log alone. Both can be true at once, and the
  // resume notice comes first because it says the whole reply may be about a
  // different project — which changes how the rest should be read.
  const notices = [result.resumeNotice, result.readOnlyNotice].filter(Boolean);
  const renderedWithNotice = notices.length
    ? `${notices.map((notice) => `> ⚠️ ${notice}`).join("\n>\n")}

${rendered}`
    : rendered;

  return {
    exitStatus: result.status,
    threadId: result.threadId ?? null,
    turnId: null,
    engine: result.engine ?? null,
    payload,
    rendered: renderedWithNotice,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write),
    ...(result.status !== 0 && failure ? { failure } : {})
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Gemini Resume" : "Gemini Task";
  const fallbackSummary = resumeLast ? "Continue previous task" : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

// `engine` here is what the caller *asked for*, and only an explicit request says
// anything: "auto" is a request to decide later, so recording it would put a
// non-engine into a field readers take for the engine in use. The engine actually
// chosen is written by the runner as soon as detection returns — see
// createJobProgressUpdater — which is what a running job under `auto` reports.
function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false, engine = null, groupId = null }) {
  const requestedEngine = engine === "auto" ? null : engine;
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write,
    ...(requestedEngine ? { engine: requestedEngine } : {}),
    ...(groupId ? { groupId } : {})
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, engine = null) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write,
    engine
  });
}

function buildTaskRequest({ cwd, model, effort, engine, prompt, write, resumeLast, jobId, timeoutSeconds = null }) {
  return {
    cwd,
    model,
    effort,
    engine,
    prompt,
    write,
    resumeLast,
    jobId,
    ...(timeoutSeconds != null ? { timeoutSeconds } : {})
  };
}

// Serializable review request for the detached review-worker. A normal single
// review re-resolves base/scope when the worker runs. A grouped blind review may
// supply one preparedReview snapshot so every engine receives byte-identical
// input even if the working tree changes between worker starts.
function buildReviewRequest({ cwd, base, scope, model, effort, engine, focusText, reviewName, templateName, deep = false, preparedReview = null, timeoutSeconds = null }) {
  return {
    cwd,
    base,
    scope,
    model,
    effort,
    engine,
    focusText,
    reviewName,
    templateName,
    deep,
    ...(timeoutSeconds != null ? { timeoutSeconds } : {}),
    ...(preparedReview ? { preparedReview } : {})
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedWorker(cwd, jobId, workerCommand, spawnFn = spawn) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawnFn(process.execPath, [scriptPath, workerCommand, "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

// Persist a job and hand it to a detached worker (`task-worker` or
// `review-worker`). Both job classes share the same enqueue/state machinery; the
// worker subcommand only decides which executor deserializes the request.
function enqueueBackgroundJob(cwd, job, request, workerCommand, { spawnFn = spawn } = {}) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedWorker(cwd, job.id, workerCommand, spawnFn);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile,
      ...(job.engine ? { engine: job.engine } : {}),
      ...(job.groupId ? { groupId: job.groupId } : {})
    },
    logFile
  };
}

// `--timeout <seconds>`. Before this existed, a turn that produced more output
// than the fixed window allowed was killed and reported as `timeout (retryable)`
// — advice that cannot work, because the cause is the size of the request, not a
// transient fault. Retrying an identical batch fails identically.
function parseTimeoutSeconds(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < MIN_TURN_TIMEOUT_SECONDS || seconds > MAX_TURN_TIMEOUT_SECONDS) {
    throw new Error(
      `Invalid --timeout "${value}". Give whole seconds between ${MIN_TURN_TIMEOUT_SECONDS} and ${MAX_TURN_TIMEOUT_SECONDS}.`
    );
  }
  return seconds;
}

function validateEffortLevel(effort) {
  if (effort != null && !VALID_EFFORT_LEVELS.has(String(effort).trim().toLowerCase())) {
    throw new Error(`Invalid --effort "${effort}". Valid values: ${[...VALID_EFFORT_LEVELS].join(", ")}.`);
  }
}

// Detached workers must never be started with a selection that their target
// engine will reject. Preserve the engine-specific representation in the
// persisted request so the worker has no extra normalization responsibility.
function prepareEngineSelection(engineInfo, model, effort) {
  const requestedModel = model ?? null;
  const requestedEffort = effort ?? null;
  validateEffortLevel(requestedEffort);
  if (!requestedModel && !requestedEffort) return { model: requestedModel, effort: requestedEffort };

  if (engineInfo.engine === "agy") {
    if (!supportsAgyModelSelection(engineInfo.version)) {
      throw new Error(`AGY ${engineInfo.version} does not support --model/--effort. AGY 1.1.5 through 1.1.9 accept the flags but ignore them in headless runs. Upgrade to AGY 1.1.10 or newer, or select --engine gemini.`);
    }
    const agyModel = normalizeAgyRequestedModel(requestedModel);
    const agyEffort = normalizeAgyEffort(requestedEffort);
    if (agyModel && agyEffort) {
      throw new Error("AGY cannot combine --model with --effort for its available model IDs. Select a model or an effort level, not both.");
    }
    return { model: agyModel, effort: agyEffort };
  }

  return { model: normalizeRequestedModel(requestedModel), effort: requestedEffort };
}

function prepareBackgroundSelection(request, detectEngineFn) {
  const model = request.model ?? null;
  const effort = request.effort ?? null;
  validateEffortLevel(effort);
  if (!model && !effort) return { model, effort };
  return prepareEngineSelection(
    detectEngineFn(request.engine ?? null),
    model,
    effort
  );
}

export function dispatchBackgroundReview(request, { spawnFn = spawn, detectEngineFn = detectEngine } = {}) {
  const cwd = path.resolve(request.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const selection = prepareBackgroundSelection(request, detectEngineFn);
  const reviewName = request.reviewName ?? "Review";
  const templateName = request.templateName ?? "review";
  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: request.base, scope: request.scope });
  const kind = templateName === "adversarial-review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Gemini ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`,
    engine: request.engine,
    groupId: request.groupId
  });
  const storedRequest = buildReviewRequest({
    cwd,
    base: request.base,
    scope: request.scope,
    model: selection.model,
    effort: selection.effort,
    engine: request.engine,
    focusText: request.focusText ?? "",
    reviewName,
    templateName,
    deep: request.deep,
    timeoutSeconds: request.timeoutSeconds ?? null,
    preparedReview: request.preparedReview
  });
  return enqueueBackgroundJob(cwd, job, storedRequest, "review-worker", { spawnFn }).payload;
}

export function dispatchAdversarialReview(request, {
  spawnFn = spawn,
  detectEngineFn = detectEngine,
  stderr = process.stderr
} = {}) {
  const engineValues = Array.isArray(request.engines) ? request.engines : String(request.engines ?? "").split(",");
  const requestedEngines = [...new Set(engineValues.map((engine) => String(engine).trim().toLowerCase()).filter(Boolean))];
  if (requestedEngines.length === 0) throw new Error("--engines requires at least one engine.");
  const invalid = requestedEngines.filter((engine) => engine !== "gemini" && engine !== "agy");
  if (invalid.length > 0) throw new Error(`Unknown review engine: ${invalid.join(", ")}. Valid engines: gemini, agy.`);

  const available = [];
  const unavailable = [];
  for (const engine of requestedEngines) {
    try {
      available.push({ engine, info: detectEngineFn(engine) });
    } catch (error) {
      unavailable.push({ engine, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (available.length === 0) {
    throw new Error(`None of the requested review engines are available: ${unavailable.map(({ engine, error }) => `${engine} (${error})`).join("; ")}.`);
  }

  const availableEngines = available.map(({ engine }) => engine);
  if (availableEngines.length > 1 && request.model != null) {
    throw new Error("--model cannot be used with --engines gemini,agy because model IDs are engine-specific. Run separate reviews with --engine.");
  }

  const warning = unavailable.length > 0
    ? `Adversarial review degraded to ${availableEngines.join(", ")}; unavailable: ${unavailable.map(({ engine }) => engine).join(", ")}.`
    : null;
  if (warning) stderr.write(`${warning}\n`);

  const groupId = available.length > 1 ? generateJobId("review-group") : null;
  const preparedReview = groupId ? buildReviewPrompt({
    ...request,
    cwd: path.resolve(request.cwd ?? process.cwd()),
    reviewName: "Adversarial Review",
    templateName: "adversarial-review"
  }) : null;
  // Validate every selected engine before the first detached worker is spawned.
  // Otherwise a later validation error can orphan an earlier group member.
  const preparedSelections = available.map(({ engine, info }) => ({
    engine,
    selection: prepareEngineSelection(info, request.model, request.effort)
  }));
  const jobs = preparedSelections.map(({ engine, selection }) => dispatchBackgroundReview({
    ...request,
    ...selection,
    engine,
    groupId,
    preparedReview,
    reviewName: "Adversarial Review",
    templateName: "adversarial-review"
  }, { spawnFn, detectEngineFn }));
  return {
    groupId,
    jobIds: jobs.map((job) => job.jobId),
    jobs,
    engines: availableEngines,
    unavailableEngines: unavailable.map(({ engine }) => engine),
    degraded: unavailable.length > 0,
    warning
  };
}

function renderQueuedReviewGroupLaunch(payload) {
  return `Gemini adversarial review group ${payload.groupId} started in the background (${payload.engines.join(", ")}). Check /gemini:status ${payload.groupId} for progress.\n`;
}

export function dispatchBackgroundTask(request, { spawnFn = spawn, detectEngineFn = detectEngine } = {}) {
  const cwd = path.resolve(request.cwd ?? process.cwd());
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const { model, effort } = prepareBackgroundSelection(request, detectEngineFn);
  const prompt = request.prompt ?? "";
  const resumeLast = Boolean(request.resumeLast);
  requireTaskRequest(prompt, resumeLast);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = buildTaskJob(workspaceRoot, taskMetadata, Boolean(request.write), request.engine ?? null);
  const storedRequest = buildTaskRequest({
    cwd,
    model,
    effort,
    engine: request.engine ?? null,
    prompt,
    write: Boolean(request.write),
    resumeLast,
    jobId: job.id,
    timeoutSeconds: request.timeoutSeconds ?? null
  });
  return enqueueBackgroundJob(cwd, job, storedRequest, "task-worker", { spawnFn }).payload;
}

function resolveFocusText(focusFile, positionals) {
  const inline = positionals.join(" ").trim();
  if (!focusFile) return inline;
  if (inline) {
    throw new Error("Pass review focus either as --focus-file or as positional text, not both.");
  }
  try {
    return fs.readFileSync(focusFile, "utf8").trim();
  } catch (error) {
    throw new Error(`Could not read --focus-file "${focusFile}": ${error.message}`);
  }
}

async function handleReviewCommand(argv, { reviewName, templateName, supportsFocus, supportsEngines = false }) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "engine", "cwd", "timeout", "focus-file", ...(supportsEngines ? ["engines"] : [])],
    booleanOptions: ["json", "wait", "background", "deep"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Focus is free text, and free text must not travel through a shell: a slash
  // command that interpolated it into its command string had `$(…)` evaluated
  // before this process started. `--focus-file` lets the caller write it with a
  // file-writing tool instead, so it never appears on a command line.
  const focusText = supportsFocus ? resolveFocusText(options["focus-file"], positionals) : "";
  validateEffortLevel(options.effort);
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);

  if (supportsEngines && options.engines != null) {
    if (options.engine != null) throw new Error("Choose either --engine or --engines, not both.");
    if (options.wait) throw new Error("--engines dispatches background jobs and cannot be combined with --wait.");
    const dispatch = dispatchAdversarialReview({
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      effort: options.effort ?? null,
      engines: String(options.engines).split(","),
      focusText,
      deep: options.deep,
      timeoutSeconds
    });
    if (dispatch.groupId) {
      const payload = {
        groupId: dispatch.groupId,
        jobIds: dispatch.jobIds,
        status: "queued",
        engines: dispatch.engines
      };
      outputCommandResult(payload, renderQueuedReviewGroupLaunch(payload), options.json);
    } else {
      const payload = dispatch.jobs[0];
      outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    }
    return;
  }

  if (options.background) {
    // Persist the review to a detached review-worker so the result survives an
    // interrupted Claude session (parity with background tasks). Returns a job id
    // immediately; track via /gemini:status and /gemini:result.
    const payload = dispatchBackgroundReview({
      cwd,
      base: options.base,
      scope: options.scope,
      model: options.model,
      effort: options.effort ?? null,
      engine: options.engine,
      focusText,
      reviewName,
      templateName,
      deep: options.deep,
      timeoutSeconds
    });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  ensureGitRepository(cwd);
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const kind = templateName === "adversarial-review" ? "adversarial-review" : "review";
  const job = createCompanionJob({
    prefix: "review",
    kind,
    title: `Gemini ${reviewName}`,
    workspaceRoot,
    jobClass: "review",
    summary: `${reviewName} ${target.label}`,
    engine: options.engine ?? null
  });

  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        target,
        base: options.base,
        scope: options.scope,
        model: options.model,
        effort: options.effort ?? null,
        engine: options.engine,
        focusText,
        reviewName,
        templateName,
        deep: options.deep,
        timeoutSeconds,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, { reviewName: "Review", templateName: "review", supportsFocus: false });
}

async function handleAdversarialReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Adversarial Review",
    templateName: "adversarial-review",
    supportsFocus: true,
    supportsEngines: true
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "engine", "cwd", "prompt-file", "timeout"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: { m: "model" }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = options.model ?? null;
  const engine = options.engine ?? null;
  validateEffortLevel(options.effort);
  const timeoutSeconds = parseTimeoutSeconds(options.timeout);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });

  if (options.background) {
    const payload = dispatchBackgroundTask({
      cwd,
      model: options.model,
      effort: options.effort ?? null,
      engine,
      prompt,
      write,
      resumeLast,
      timeoutSeconds
    });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write, engine);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort: options.effort ?? null,
        engine,
        prompt,
        write,
        resumeLast,
        timeoutSeconds,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

// Shared worker body for the detached `task-worker` / `review-worker` subcommands:
// load the persisted job, deserialize its request, and run the matching executor
// under runTrackedJob (which records running/completed/failed state + result).
async function runStoredJobWorker(argv, { executor, label }) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error(`Missing required --job-id for ${label}.`);
  }

  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executor({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleTaskWorker(argv) {
  return runStoredJobWorker(argv, { executor: executeTaskRun, label: "task-worker" });
}

async function handleReviewWorker(argv) {
  return runStoredJobWorker(argv, { executor: executeReviewRun, label: "review-worker" });
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(
      snapshot,
      snapshot.groupId ? renderJobGroupStatusReport(snapshot) : renderJobStatusReport(snapshot.job),
      options.json
    );
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

export function getJobStatus({ cwd = process.cwd(), jobId }) {
  return buildSingleJobSnapshot(path.resolve(cwd), jobId);
}

export function getJobResult({ cwd = process.cwd(), jobId, all = false }) {
  const resolved = resolveResultJobs(path.resolve(cwd), jobId, { all });
  if (resolved.groupId) {
    return {
      groupId: resolved.groupId,
      results: resolved.jobs.map((job) => ({ job, storedJob: readStoredJob(resolved.workspaceRoot, job.id) }))
    };
  }
  return { job: resolved.job, storedJob: readStoredJob(resolved.workspaceRoot, resolved.job.id) };
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const payload = getJobResult({ cwd, jobId: reference, all: options.all });

  outputCommandResult(
    payload,
    payload.groupId ? renderStoredJobGroupResult(payload) : renderStoredJobResult(payload.job, payload.storedJob),
    options.json
  );
}

async function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  // Resume candidates are scoped to the current Claude session by default, and
  // must agree with resolveLatestTrackedTaskThread — this command exists to tell
  // the agent what that one will pick, so an untagged job offered here and
  // refused there would be worse than not offering it.
  const jobs = sortJobsNewestFirst(
    filterJobsForCurrentSession(listJobs(workspaceRoot), { includeUnattributed: false })
  );
  const activeTask = jobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    // `available` mirrors upstream codex-companion (rescue.md keys off it). Do not
    // rename to `found` — commands/rescue.md asks the agent to read `available`.
    const payload = { available: false, blocked: true, activeJobId: activeTask.id };
    outputResult(
      options.json ? payload : `Task ${activeTask.id} is still running. Use /gemini:status before resuming.\n`,
      options.json
    );
    return;
  }
  const candidate = jobs.find((job) => job.jobClass === "task" && job.status === "completed" && job.threadId);
  const payload = candidate
    ? { available: true, jobId: candidate.id, threadId: candidate.threadId, title: candidate.title }
    : { available: false };
  outputResult(
    options.json ? payload : (candidate ? `Resume candidate: ${candidate.id} — ${candidate.title}\n` : "No resume candidate found.\n"),
    options.json
  );
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { payload, job, termination } = cancelJob({ cwd, jobId: reference, all: options.all });

  outputCommandResult(payload, renderCancelReport(job, termination), options.json);
}

export function cancelJob({ cwd = process.cwd(), jobId = "", all = false }, { terminateProcessTreeFn = terminateProcessTree } = {}) {
  const { workspaceRoot, job } = resolveCancelableJob(path.resolve(cwd), jobId, { all });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  // Be honest about whether a live process was actually killed: the detached
  // worker is unref()-ed, so by cancel time its PID may already be gone. The job
  // is still marked cancelled (the user's intent is recorded) in every case.
  const termination = terminateProcessTreeFn(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, `Cancelled by user — ${describeTermination(termination)}.`);

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    processTerminated: termination.delivered
  };

  return { payload, job: nextJob, termination };
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  // `<subcommand> --help` prints usage and exits 0 rather than reaching an
  // engine. Handled before dispatch so it applies to every subcommand, including
  // the ones whose positionals are free text and would otherwise swallow it.
  if (isHelpRequest(argv)) {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleAdversarialReview(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review-worker":
      await handleReviewWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

if (process.argv[1] === SELF_PATH) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
