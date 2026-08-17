import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeReadOnlyWrites, detectWrites, snapshotWorkspace } from "../plugins/gemini/scripts/lib/readonly-guard.mjs";
import { initGitRepo } from "./helpers.mjs";

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-guard-"));
  initGitRepo(dir);
  return dir;
}

// The promise being kept: a turn the user asked to be read-only cannot write
// without saying so. It is not a permission check — AGY has no read-only mode —
// so the property is visibility, and "not checked" must never read as "clean".

test("a turn that writes nothing produces no notice", () => {
  const repo = tempRepo();
  const before = snapshotWorkspace(repo);
  assert.equal(describeReadOnlyWrites(detectWrites(before, repo)), null);
});

test("a file created during the turn is named", () => {
  const repo = tempRepo();
  const before = snapshotWorkspace(repo);
  fs.writeFileSync(path.join(repo, "written-by-the-model.txt"), "surprise", "utf8");

  const detection = detectWrites(before, repo);
  assert.equal(detection.checked, true);
  assert.deepEqual(detection.written, ["written-by-the-model.txt"]);
  assert.match(describeReadOnlyWrites(detection), /written-by-the-model\.txt/);
  assert.match(describeReadOnlyWrites(detection), /without --write/);
});

test("a file that was already dirty beforehand is not blamed on the turn", () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, "the-user-was-editing-this.txt"), "mine", "utf8");
  const before = snapshotWorkspace(repo);

  assert.equal(describeReadOnlyWrites(detectWrites(before, repo)), null);
});

test("a file that stopped being dirty is not reported as a write", () => {
  // Committing mid-run, or a build cleaning a stray artifact, removes an entry.
  // Only additions are evidence.
  const repo = tempRepo();
  const stray = path.join(repo, "stray.txt");
  fs.writeFileSync(stray, "x", "utf8");
  const before = snapshotWorkspace(repo);
  fs.rmSync(stray);

  const detection = detectWrites(before, repo);
  assert.deepEqual(detection.written, []);
});

test("a workspace that cannot be compared says so instead of passing", () => {
  // The dangerous confusion is "not checked" looking like "checked, clean".
  const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-guard-plain-"));
  const before = snapshotWorkspace(notARepo);
  const detection = detectWrites(before, notARepo);

  assert.equal(detection.checked, false);
  const notice = describeReadOnlyWrites(detection);
  assert.ok(notice, "an uncheckable workspace must still produce a notice");
  assert.match(notice, /could not be compared/);
  assert.match(notice, /possibly modified/);
});

test("many writes are summarised without dropping the count", () => {
  const repo = tempRepo();
  const before = snapshotWorkspace(repo);
  for (let i = 0; i < 14; i += 1) {
    fs.writeFileSync(path.join(repo, `file-${String(i).padStart(2, "0")}.txt`), "x", "utf8");
  }
  const notice = describeReadOnlyWrites(detectWrites(before, repo));
  assert.match(notice, /and 4 more/);
});

test("describeReadOnlyWrites tolerates a missing detection", () => {
  assert.equal(describeReadOnlyWrites(null), null);
  assert.equal(describeReadOnlyWrites(undefined), null);
});

// --- touchedFiles is a measurement, not a guess -----------------------------
// It used to be a regex for filename-shaped tokens in the model's reply. That
// reported files merely mentioned — including ones absent from the workspace —
// and missed files changed without being named. Both directions wrong, with no
// render path and no test, which is why it survived.

import { resolveResumeMismatch, runGeminiTurn } from "../plugins/gemini/scripts/lib/gemini.mjs";

function agyEngine() {
  return () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.10" });
}

function envelope(response) {
  return `${JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response, num_turns: 1 })}\n`;
}

test("a file the reply merely names is not reported as touched", async () => {
  const repo = tempRepo();
  const result = await runGeminiTurn(
    repo,
    { prompt: "p", write: false, engine: "agy" },
    {
      detectEngineFn: agyEngine(),
      // The reply talks about files without changing anything.
      runCommandFn: () => ({
        status: 0,
        stdout: envelope("I read src/index.mjs and package.json and hooks/hooks.json."),
        stderr: ""
      })
    }
  );
  assert.deepEqual(result.touchedFiles, [], "naming a file is not touching it");
  assert.equal(result.readOnlyNotice ?? null, null);
});

test("a file changed during the turn is reported even if the reply never names it", async () => {
  const repo = tempRepo();
  const result = await runGeminiTurn(
    repo,
    { prompt: "p", write: true, engine: "agy" },
    {
      detectEngineFn: agyEngine(),
      runCommandFn: () => {
        // Stand in for the delegated engine writing to the workspace.
        fs.writeFileSync(path.join(repo, "quietly-changed.txt"), "x", "utf8");
        return { status: 0, stdout: envelope("Done."), stderr: "" };
      }
    }
  );
  assert.deepEqual(result.touchedFiles, ["quietly-changed.txt"]);
});

test("a write turn reports what it changed without a read-only warning", async () => {
  const repo = tempRepo();
  const result = await runGeminiTurn(
    repo,
    { prompt: "p", write: true, engine: "agy" },
    {
      detectEngineFn: agyEngine(),
      runCommandFn: () => {
        fs.writeFileSync(path.join(repo, "asked-for.txt"), "x", "utf8");
        return { status: 0, stdout: envelope("Done."), stderr: "" };
      }
    }
  );
  assert.deepEqual(result.touchedFiles, ["asked-for.txt"]);
  assert.equal(result.readOnlyNotice ?? null, null, "the user asked for edits; that is not a warning");
});

// --- a resume is verified, not assumed ---------------------------------------
// Same shape as the read-only guard above, and for the same reason: gemini's
// `--resume latest` cannot be pinned to an id, so the only honest thing to do is
// compare where it landed. Silence has to mean "checked, correct".

test("a resume that lands on the requested thread says nothing", () => {
  assert.equal(
    resolveResumeMismatch({ resumeThreadId: "thr_1", threadId: "thr_1", engine: "agy" }),
    null
  );
});

test("a resume that lands elsewhere names both threads", () => {
  const notice = resolveResumeMismatch({ resumeThreadId: "thr_1", threadId: "thr_9", engine: "gemini" });
  assert.match(notice, /thr_9/);
  assert.match(notice, /thr_1/);
  assert.match(notice, /gemini/);
});

test("a write turn's mismatch says where the edits may have gone", () => {
  // A resumed conversation keeps its own workspace, so this is not merely a
  // wrong answer — it is edits in another repository.
  const notice = resolveResumeMismatch({ resumeThreadId: "thr_1", threadId: "thr_9", engine: "agy", write: true });
  assert.match(notice, /may have landed in that conversation's directory/);
});

test("a turn that was not resuming is never reported as a mismatch", () => {
  assert.equal(resolveResumeMismatch({ resumeThreadId: null, threadId: "thr_9", engine: "agy" }), null);
});

test("a turn that came back with no thread id invents no mismatch", () => {
  // A killed or failed turn has nothing to compare; claiming it landed wrong
  // would be manufacturing a finding out of missing data.
  assert.equal(resolveResumeMismatch({ resumeThreadId: "thr_1", threadId: null, engine: "agy" }), null);
});

test("a read-only turn that writes reports it in both places", async () => {
  const repo = tempRepo();
  const result = await runGeminiTurn(
    repo,
    { prompt: "p", write: false, engine: "agy" },
    {
      detectEngineFn: agyEngine(),
      runCommandFn: () => {
        fs.writeFileSync(path.join(repo, "should-not-exist.txt"), "x", "utf8");
        return { status: 0, stdout: envelope("Done."), stderr: "" };
      }
    }
  );
  assert.deepEqual(result.touchedFiles, ["should-not-exist.txt"]);
  assert.match(result.readOnlyNotice, /should-not-exist\.txt/);
});
