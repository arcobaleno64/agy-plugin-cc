import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeReadOnlyWrites, detectWrites, snapshotWorkspace } from "../plugins/gemini/scripts/lib/readonly-guard.mjs";
import { initGitRepo, run } from "./helpers.mjs";

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-guard-"));
  initGitRepo(dir);
  return dir;
}

const canCreateFileSymlink = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readonly-link-probe-"));
  try {
    fs.symlinkSync(path.join(dir, "missing"), path.join(dir, "link"), "file");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

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

test("a file that was already dirty and changed again during the turn is named", () => {
  const repo = tempRepo();
  const file = path.join(repo, "the-user-was-editing-this.txt");
  fs.writeFileSync(file, "mine", "utf8");
  const before = snapshotWorkspace(repo);

  fs.writeFileSync(file, "changed by the delegated turn", "utf8");

  const detection = detectWrites(before, repo);
  assert.deepEqual(detection.written, ["the-user-was-editing-this.txt"]);
  assert.match(describeReadOnlyWrites(detection), /the-user-was-editing-this\.txt/);
});

test("a dirty file removed during the turn is named", () => {
  const repo = tempRepo();
  const stray = path.join(repo, "stray.txt");
  fs.writeFileSync(stray, "x", "utf8");
  const before = snapshotWorkspace(repo);
  fs.rmSync(stray);

  const detection = detectWrites(before, repo);
  assert.deepEqual(detection.written, ["stray.txt"]);
});

test("a dirty Unicode path changed again during the turn is named literally", () => {
  const repo = tempRepo();
  const file = path.join(repo, "café.txt");
  fs.writeFileSync(file, "mine", "utf8");
  const before = snapshotWorkspace(repo);

  fs.writeFileSync(file, "changed", "utf8");

  assert.deepEqual(detectWrites(before, repo).written, ["café.txt"]);
});

test("a dirty submodule changed again during the turn is named", () => {
  const repo = tempRepo();
  const source = tempRepo();
  fs.writeFileSync(path.join(source, "nested.txt"), "initial", "utf8");
  run("git", ["add", "nested.txt"], { cwd: source });
  run("git", ["commit", "-m", "fixture"], { cwd: source });
  run("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "nested"], { cwd: repo });
  run("git", ["commit", "-am", "add submodule"], { cwd: repo });

  const nestedFile = path.join(repo, "nested", "nested.txt");
  fs.writeFileSync(nestedFile, "dirty before", "utf8");
  const before = snapshotWorkspace(repo);
  fs.writeFileSync(nestedFile, "changed again", "utf8");

  assert.deepEqual(detectWrites(before, repo).written, ["nested"]);
});

test("untracked submodule content changed again during the turn is named", () => {
  const repo = tempRepo();
  const source = tempRepo();
  fs.writeFileSync(path.join(source, "tracked.txt"), "fixture", "utf8");
  run("git", ["add", "tracked.txt"], { cwd: source });
  run("git", ["commit", "-m", "fixture"], { cwd: source });
  run("git", ["-c", "protocol.file.allow=always", "submodule", "add", source, "nested"], { cwd: repo });
  run("git", ["commit", "-am", "add submodule"], { cwd: repo });

  const untracked = path.join(repo, "nested", "untracked.txt");
  fs.writeFileSync(untracked, "dirty before", "utf8");
  const before = snapshotWorkspace(repo);
  fs.writeFileSync(untracked, "changed again", "utf8");

  assert.deepEqual(detectWrites(before, repo).written, ["nested"]);
});

test("a dangling symlink retargeted during the turn is named", { skip: !canCreateFileSymlink }, () => {
  const repo = tempRepo();
  const link = path.join(repo, "dangling-link");
  fs.symlinkSync(path.join(repo, "missing-a"), link, "file");
  const before = snapshotWorkspace(repo);

  fs.unlinkSync(link);
  fs.symlinkSync(path.join(repo, "missing-b"), link, "file");

  assert.deepEqual(detectWrites(before, repo).written, ["dangling-link"]);
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

// --- a review is read-only too, and --deep needs somewhere to read -----------

import { runGeminiReview } from "../plugins/gemini/scripts/lib/gemini.mjs";

function reviewEnvelope(response) {
  return `${JSON.stringify({ conversation_id: "c1", status: "SUCCESS", response, num_turns: 1 })}\n`;
}

const REVIEW_JSON = JSON.stringify({ verdict: "approve", summary: "ok", findings: [], next_steps: [] });

test("a deep review is oriented on the repository being reviewed", async () => {
  // Without --add-dir an AGY turn's cwd is ~/.gemini/antigravity-cli/scratch, so
  // "go and read the dependency manifests" read someone else's directory — one
  // level from `brain/`, which holds every past conversation.
  const repo = tempRepo();
  let seen = null;
  await runGeminiReview(
    repo,
    { prompt: "p", engine: "agy", deep: true },
    {
      detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.10" }),
      runCommandFn: (_binary, args) => {
        seen = args;
        return { status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" };
      }
    }
  );

  const at = seen.indexOf("--add-dir");
  assert.ok(at !== -1, `a deep review was left unoriented: ${seen.join(" ")}`);
  assert.equal(seen[at + 1], repo);
});

test("a default review is not given a workspace it does not use", async () => {
  // The diff is already in the prompt; a single-shot review has nothing to look
  // up, so it gets no orientation to look up.
  const repo = tempRepo();
  let seen = null;
  await runGeminiReview(
    repo,
    { prompt: "p", engine: "agy" },
    {
      detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.10" }),
      runCommandFn: (_binary, args) => {
        seen = args;
        return { status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" };
      }
    }
  );
  assert.ok(!seen.includes("--add-dir"));
});

test("a review that writes to the workspace is reported", async () => {
  // Nothing enforces a review's read-only intent, and --deep hands the model
  // tools. So the tree is compared rather than trusted.
  const repo = tempRepo();
  const result = await runGeminiReview(
    repo,
    { prompt: "p", engine: "agy", deep: true },
    {
      detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.10" }),
      runCommandFn: () => {
        fs.writeFileSync(path.join(repo, "review-wrote-this.txt"), "x", "utf8");
        return { status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" };
      }
    }
  );
  assert.match(result.readOnlyNotice, /review-wrote-this\.txt/);
  assert.deepEqual(result.readOnlyWrites, ["review-wrote-this.txt"]);
});

test("a review that changes nothing says nothing", async () => {
  const repo = tempRepo();
  const result = await runGeminiReview(
    repo,
    { prompt: "p", engine: "agy", deep: true },
    {
      detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.10" }),
      runCommandFn: () => ({ status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" })
    }
  );
  assert.equal(result.readOnlyNotice ?? null, null);
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
