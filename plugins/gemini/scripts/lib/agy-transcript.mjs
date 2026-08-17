// agy-transcript.mjs — recover authoritative AGY responses from disk.
//
// WHY THIS EXISTS
// ---------------
// Older positional `agy --print` releases did not deliver their response over
// stdout in non-TTY use (google-gemini/gemini-cli#27466; verified on AGY 1.0.3
// Windows and 1.0.7 macOS). AGY 1.1.2 can accept the prompt on stdin and return
// stdout, but the transcript still supplies the cross-version response, DONE
// status, thinking, and conversation id. The adapter therefore keeps transcript
// recovery authoritative on both transport paths.
//
// SYNCHRONOUS MODEL (important)
// -----------------------------
// runCommand() is spawnSync. By the time it returns, agy has already exited and
// the transcript is final — UNLESS the spawn timeout SIGKILLed it mid-flush, in
// which case the final row may be missing or status != "DONE". So there is NO
// in-flight polling: snapshot dirs -> spawn (blocks) -> snapshot dirs -> diff.
//
// MACHINE-VERIFIED FINDINGS (agy 1.0.3, Windows, 2026-06-01):
//   TODO-1 (id capture): RESOLVED — uuid pinning does NOT work. A probe of
//     `agy --conversation <fresh-uuid> --print "..."` did not create
//     brain/<uuid>/ (it hung and wrote nothing); `--conversation` only resumes
//     an EXISTING id (antigravity-cli#7 still open). => the set-diff path below
//     is required, and a fresh turn must NOT pass --conversation.
//   TODO-2 (concurrency): RESOLVED by refusal, not by a lock. Its premise —
//     one foreground agy turn at a time — stopped holding when --background
//     arrived, and the "confident=false so the caller can warn" mitigation was
//     silent in exactly that case (detached workers run with stdio "ignore").
//     pickNewConvDir now attributes nothing when >1 new dir appears; see there.
//   TODO-3 (platform paths): RESOLVED — Windows 1.0.3 and macOS 1.0.7 share
//     the ~/.gemini/antigravity-cli/brain root (both machine-verified, macOS
//     2026-06-12 end-to-end: task --engine agy recovered the transcript);
//     Linux 1.0.2 reported at ~/.antigravity-cli/brain. Timeout grace IS
//     applied in runGeminiTurn (agy --print-timeout window < the hard spawn
//     kill).
//
// AGY 1.1.0 (2026-07-08): `agy --help` confirms this brain-root path and the
// four flags this file/engine.mjs depend on are unchanged; 1.1.0's global
// config-dir fix (~/.gemini/antigravity-cli/ -> ~/.gemini/config/) is about
// the /agents subagent-definition dir, a different path from the brain root
// below. Machine-verified 2026-07-09 (Windows): 1.1.0's new default
// `request-review` mode does NOT stall a headless `--engine agy --write`
// spawn — at the time, --dangerously-skip-permissions bypassed it. That flag
// was removed in v0.16.0 because AGY 1.1.10 auto-approves headlessly without
// it (docs/THREAT-MODEL.md 7.2). The 1.1.0 `request-review` interaction was
// NOT re-measured without the flag; on that version a write turn could in
// principle stall, which would surface as a --print-timeout. Separately found
// (and fixed in buildCliArgs via --new-project, see engine.mjs and
// CHANGELOG): without an active workspace, that same write turn used to
// silently land its file under this brain root's sibling `scratch/` dir
// instead of `cwd`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { classifyCliFailure } from "./failures.mjs";

// Candidate brain roots, newest-platform first. Verified: 1.0.3 and 1.1.0
// Windows, 1.0.7 macOS (same root). Reported: 1.0.2 Linux.
export function agyBrainRoots() {
  const home = os.homedir();
  return [
    path.join(home, ".gemini", "antigravity-cli", "brain"), // 1.0.3/1.1.0 Windows + 1.0.7 macOS (verified)
    path.join(home, ".antigravity-cli", "brain"),           // 1.0.2 Linux (reported)
  ];
}

export function resolveAgyBrainRoot() {
  for (const root of agyBrainRoots()) {
    try {
      if (fs.statSync(root).isDirectory()) return root;
    } catch {
      // not present on this platform / not yet created — try next
    }
  }
  return null;
}

// Map<conversationId, mtimeMs> of conversation dirs directly under brainRoot.
export function listConvDirs(brainRoot) {
  const m = new Map();
  if (!brainRoot) return m;
  let entries;
  try {
    entries = fs.readdirSync(brainRoot, { withFileTypes: true });
  } catch {
    return m;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(brainRoot, e.name);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      // dir vanished between readdir and stat — skip
    }
    m.set(e.name, mtime);
  }
  return m;
}

// Set-difference id capture: dirs present AFTER the spawn but not BEFORE.
// More robust than mtime comparison — it ignores external touches to existing
// dirs and only counts genuinely new ones.
//
// When more than one appears there is nothing to choose between them. This used
// to pick the newest by mtime and set confident=false "so the caller can warn"
// (TODO-2), which held only while TODO-2's premise did: one foreground AGY turn
// at a time. `--background` broke it. Two concurrent background turns both
// snapshot, both see both dirs, and a turn killed by its timeout then rendered
// the *other* job's answer as its own — with the warning written to a stderr
// that spawnDetachedWorker sets to "ignore", so nothing reached the user.
//
// mtime cannot resolve it either: the other job's dir is still being written, so
// "newest" actively favours the wrong one. So this refuses instead. The turn ran
// and was billed, and the reason says so; `transcript-ambiguous` is retryable and
// tells the user to retry when no other AGY run is starting.
export function pickNewConvDir(before, after) {
  const added = [];
  for (const [name, mtime] of after) {
    if (!before.has(name)) added.push({ name, mtime });
  }
  if (added.length === 0) {
    return { dir: null, confident: false, reason: "no new conversation dir appeared after spawn" };
  }
  if (added.length > 1) {
    return {
      dir: null,
      confident: false,
      reason: `${added.length} new conversation dirs appeared during this spawn, so the match is ambiguous and none can be attributed to this turn`
    };
  }
  return { dir: added[0].name, confident: true, reason: "single new dir" };
}

// Read the final model response from a conversation's transcript.
// Prefers transcript_full.jsonl (complete history for long convos) over
// transcript.jsonl. Returns the LAST MODEL/PLANNER_RESPONSE row's content.
export function readAgyTranscript(brainRoot, convDir) {
  const logDir = path.join(brainRoot, convDir, ".system_generated", "logs");
  const candidates = [
    path.join(logDir, "transcript_full.jsonl"),
    path.join(logDir, "transcript.jsonl"),
  ];

  let file = null;
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        file = c;
        break;
      }
    } catch {
      // try next candidate
    }
  }
  if (!file) {
    const reason = "no transcript file found";
    return { response: null, thinking: null, done: false, reason, failure: classifyCliFailure({ transcriptReason: reason }) };
  }

  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    const reason = `transcript read failed: ${e.message}`;
    return { response: null, thinking: null, done: false, reason, failure: classifyCliFailure({ transcriptReason: reason }) };
  }

  // JSONL: one object per line. Tolerate partial/garbled lines (a SIGKILL during
  // flush can leave a truncated final line) by skipping unparseable rows.
  let last = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // truncated/garbled row — skip
    }
    if (obj && obj.source === "MODEL" && obj.type === "PLANNER_RESPONSE") {
      last = obj;
    }
  }

  if (!last) {
    const reason = "no PLANNER_RESPONSE row in transcript";
    return { response: null, thinking: null, done: false, reason, failure: classifyCliFailure({ transcriptReason: reason }) };
  }

  const done = last.status === "DONE";
  const reason = done ? "ok" : `final PLANNER_RESPONSE status=${last.status ?? "unknown"} — possible truncation from spawn timeout`;
  return {
    response: last.content ?? null,
    thinking: last.thinking ?? null,
    done, // false => agy was likely SIGKILLed before finishing (see timeout grace, TODO-3 integration note)
    reason,
    ...(!done ? { failure: classifyCliFailure({ transcriptReason: reason }) } : {})
  };
}

// Convenience wrapper: call listConvDirs(brainRoot) BEFORE the spawn, pass the
// result here AFTER the spawn returns.
export function recoverAgyResponse(brainRoot, beforeSnapshot) {
  if (!brainRoot) {
    const reason = "no agy brain root found on this platform (run agy once to create it; see agyBrainRoots() for the known roots)";
    return { response: null, thinking: null, done: false, confident: false, convDir: null, reason, failure: classifyCliFailure({ transcriptReason: reason }) };
  }
  const after = listConvDirs(brainRoot);
  const picked = pickNewConvDir(beforeSnapshot, after);
  if (!picked.dir) {
    return { response: null, thinking: null, done: false, confident: false, convDir: null, reason: picked.reason, failure: classifyCliFailure({ transcriptReason: picked.reason }) };
  }
  // A dir here is an unambiguous one — pickNewConvDir attributes nothing when it
  // cannot tell which conversation was this turn's. So the only remaining doubt
  // is whether the transcript finished, which is what `done` already says.
  const t = readAgyTranscript(brainRoot, picked.dir);
  return { ...t, confident: t.done, convDir: picked.dir };
}

// Integration invariant: gemini.mjs snapshots the brain directory before every
// AGY spawn and calls recoverAgyResponse afterwards. Missing recovery is passed
// to the failure classifier together with exit status and stderr; a completed
// transcript remains authoritative even when AGY also returned stdout.
