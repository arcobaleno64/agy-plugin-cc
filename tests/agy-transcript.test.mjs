import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  agyBrainRoots,
  resolveAgyBrainRoot,
  listConvDirs,
  pickNewConvDir,
  readAgyTranscript,
  recoverAgyResponse,
} from "../plugins/gemini/scripts/lib/agy-transcript.mjs";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-"));
}

// Build brainRoot/<conv>/.system_generated/logs/<file> with the given JSONL rows.
function writeTranscript(brainRoot, conv, rows, file = "transcript.jsonl") {
  const logDir = path.join(brainRoot, conv, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, file), rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n", "utf8");
  return logDir;
}

// The real agy 1.0.3 transcript shape (verified on Windows).
function realRows(answer = "PONG", status = "DONE") {
  return [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-06-01T13:44:25Z", content: "<USER_REQUEST>\nping\n</USER_REQUEST>" },
    { step_index: 1, source: "SYSTEM", type: "CONVERSATION_HISTORY", status: "DONE", created_at: "2026-06-01T13:44:25Z" },
    { step_index: 2, source: "SYSTEM", type: "EPHEMERAL_MESSAGE", status: "DONE", created_at: "2026-06-01T13:44:25Z", content: "reminders" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status, created_at: "2026-06-01T13:44:25Z", content: answer, thinking: "**Prioritizing**\nreasoning summary" },
  ];
}

test("readAgyTranscript returns the last PLANNER_RESPONSE content + thinking, done on DONE", () => {
  const root = tmpRoot();
  writeTranscript(root, "conv1", realRows("PONG", "DONE"));
  const r = readAgyTranscript(root, "conv1");
  assert.equal(r.response, "PONG");
  assert.match(r.thinking, /reasoning summary/);
  assert.equal(r.done, true);
});

test("readAgyTranscript prefers transcript_full.jsonl over transcript.jsonl", () => {
  const root = tmpRoot();
  writeTranscript(root, "conv1", realRows("FROM_TRANSCRIPT", "DONE"), "transcript.jsonl");
  writeTranscript(root, "conv1", realRows("FROM_FULL", "DONE"), "transcript_full.jsonl");
  const r = readAgyTranscript(root, "conv1");
  assert.equal(r.response, "FROM_FULL");
});

test("readAgyTranscript tolerates a truncated/garbled final line", () => {
  const root = tmpRoot();
  const rows = realRows("GOOD", "DONE");
  writeTranscript(root, "conv1", [...rows, '{"step_index":4,"source":"MOD']); // truncated row
  const r = readAgyTranscript(root, "conv1");
  assert.equal(r.response, "GOOD");
  assert.equal(r.done, true);
});

test("readAgyTranscript reports done:false when the final response is not DONE", () => {
  const root = tmpRoot();
  writeTranscript(root, "conv1", realRows("PARTIAL", "IN_PROGRESS"));
  const r = readAgyTranscript(root, "conv1");
  assert.equal(r.response, "PARTIAL");
  assert.equal(r.done, false);
  assert.match(r.reason, /status=IN_PROGRESS|truncation/i);
});

test("readAgyTranscript reports no PLANNER_RESPONSE when absent", () => {
  const root = tmpRoot();
  writeTranscript(root, "conv1", [realRows()[0], realRows()[1]]); // user + history only
  const r = readAgyTranscript(root, "conv1");
  assert.equal(r.response, null);
  assert.equal(r.done, false);
  assert.match(r.reason, /no PLANNER_RESPONSE/i);
});

test("readAgyTranscript reports a missing transcript file", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "conv1"), { recursive: true });
  const r = readAgyTranscript(root, "conv1");
  assert.equal(r.response, null);
  assert.match(r.reason, /no transcript file/i);
});

test("pickNewConvDir identifies a single new dir confidently", () => {
  const before = new Map([["a", 1]]);
  const after = new Map([["a", 1], ["b", 2]]);
  const p = pickNewConvDir(before, after);
  assert.equal(p.dir, "b");
  assert.equal(p.confident, true);
});

// This used to return the newest by mtime with confident=false. Two concurrent
// background AGY turns are enough to produce two new dirs, and the other job's
// dir is the one still being written — so "newest" pointed at the wrong
// conversation, and the caller rendered another job's answer. mtime cannot
// break the tie, so nothing is attributed.
test("pickNewConvDir attributes nothing when several new dirs appeared", () => {
  const before = new Map();
  const after = new Map([["old", 10], ["new", 20]]);
  const p = pickNewConvDir(before, after);
  assert.equal(p.dir, null, "a coin flip between conversations is not an answer");
  assert.equal(p.confident, false);
  assert.match(p.reason, /2 new conversation dirs/);
  assert.match(p.reason, /ambiguous/);
});

test("pickNewConvDir returns no dir when nothing new appeared", () => {
  const before = new Map([["a", 1]]);
  const after = new Map([["a", 1]]);
  const p = pickNewConvDir(before, after);
  assert.equal(p.dir, null);
  assert.equal(p.confident, false);
});

test("recoverAgyResponse end-to-end: before snapshot -> new conv -> recovered response", () => {
  const root = tmpRoot();
  // Pre-existing conversation present in the BEFORE snapshot.
  writeTranscript(root, "pre", realRows("OLD", "DONE"));
  const before = listConvDirs(root);
  // New conversation appears after the (simulated) spawn.
  writeTranscript(root, "fresh", realRows("NEW_ANSWER", "DONE"));
  const rec = recoverAgyResponse(root, before);
  assert.equal(rec.response, "NEW_ANSWER");
  assert.equal(rec.convDir, "fresh");
  assert.equal(rec.done, true);
  assert.equal(rec.confident, true);
});

test("recoverAgyResponse fails loud-able when no brain root is available", () => {
  const rec = recoverAgyResponse(null, new Map());
  assert.equal(rec.response, null);
  assert.equal(rec.confident, false);
  assert.match(rec.reason, /brain root/i);
  assert.equal(rec.failure.category, "transcript-missing");
  assert.equal(rec.failure.retryable, false);
});

test("recoverAgyResponse reports when no new conversation dir appears", () => {
  const root = tmpRoot();
  writeTranscript(root, "pre", realRows("OLD", "DONE"));
  const before = listConvDirs(root);
  const rec = recoverAgyResponse(root, before); // nothing new added
  assert.equal(rec.response, null);
  assert.match(rec.reason, /no new conversation dir/i);
  assert.equal(rec.failure.category, "transcript-missing");
});

test("recoverAgyResponse returns no response at all when the match is ambiguous", () => {
  // The turn ran and was billed, but neither transcript can be shown to be its
  // own. Returning either one would put another job's answer under this job's
  // id — a leak the user has no way to notice.
  const root = tmpRoot();
  const before = listConvDirs(root);
  writeTranscript(root, "older", realRows("OLDER", "DONE"));
  writeTranscript(root, "newer", realRows("NEWER", "DONE"));
  const rec = recoverAgyResponse(root, before);
  assert.equal(rec.response, null);
  assert.equal(rec.convDir, null, "no conversation id may be attributed either");
  assert.equal(rec.confident, false);
  assert.equal(rec.failure.category, "transcript-ambiguous");
  assert.equal(rec.failure.retryable, true, "retrying without a concurrent run is the fix");
});

test("recoverAgyResponse marks non-DONE transcripts as missing/incomplete", () => {
  const root = tmpRoot();
  const before = listConvDirs(root);
  writeTranscript(root, "fresh", realRows("PARTIAL", "IN_PROGRESS"));
  const rec = recoverAgyResponse(root, before);
  assert.equal(rec.done, false);
  assert.equal(rec.failure.category, "transcript-missing");
  assert.match(rec.failure.summary, /transcript/i);
});

test("listConvDirs maps conversation dirs and ignores files", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, "convA"), { recursive: true });
  fs.mkdirSync(path.join(root, "convB"), { recursive: true });
  fs.writeFileSync(path.join(root, "stray.txt"), "x", "utf8");
  const m = listConvDirs(root);
  assert.equal(m.has("convA"), true);
  assert.equal(m.has("convB"), true);
  assert.equal(m.has("stray.txt"), false);
});

test("agyBrainRoots lists platform candidates ending in 'brain'; resolve returns null or a real dir", () => {
  const roots = agyBrainRoots();
  assert.ok(Array.isArray(roots) && roots.length >= 2);
  for (const r of roots) assert.equal(path.basename(r), "brain");
  const resolved = resolveAgyBrainRoot();
  assert.ok(resolved === null || typeof resolved === "string");
});
