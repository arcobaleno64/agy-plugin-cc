import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { describeReadOnlyWrites, detectWrites, snapshotWorkspace } from "../plugins/gemini/scripts/lib/readonly-guard.mjs";
import { executeReviewRun, executeTaskRun } from "../plugins/gemini/scripts/gemini-companion.mjs";
import { runTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
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

// --- a clean working tree is not a quiet repository -------------------------
// Commits, hooks and .git/config sit outside the working-tree state, so a turn
// that only touched those used to come back as 'checked, nothing changed'.

function commitAll(repo, message) {
  run('git', ['add', '-A'], { cwd: repo });
  return run('git', ['commit', '-m', message], { cwd: repo });
}

test('a commit made during the turn is reported even though the tree stays clean', () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed', 'utf8');
  commitAll(repo, 'seed');
  const before = snapshotWorkspace(repo);

  fs.writeFileSync(path.join(repo, 'sneaky.txt'), 'x', 'utf8');
  commitAll(repo, 'sneaky');

  const detection = detectWrites(before, repo);
  assert.equal(detection.checked, true);
  assert.equal(detection.written.length, 1);
  assert.match(detection.written[0], /^\.git\/HEAD/);
  assert.match(describeReadOnlyWrites(detection), /\.git\/HEAD/);
});

test('a hook planted during the turn is reported', () => {
  const repo = tempRepo();
  const before = snapshotWorkspace(repo);
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), "#!/bin/sh\n", "utf8");
  assert.deepEqual(detectWrites(before, repo).written, ['.git/hooks']);
});

test('a .git/config change during the turn is reported', () => {
  const repo = tempRepo();
  const before = snapshotWorkspace(repo);
  run('git', ['config', 'alias.st', 'status'], { cwd: repo });
  assert.deepEqual(detectWrites(before, repo).written, ['.git/config']);
});

test('an untouched repository reports no repository-level change', () => {
  const repo = tempRepo();
  const before = snapshotWorkspace(repo);
  assert.deepEqual(detectWrites(before, repo).written, []);
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

test("AGY default review isolates cwd, ignores repo hooks, applies review-diff settings, and snapshots repo", async () => {
  const repo = tempRepo();
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "hooks.json"), "{}\n", "utf8");

    let seenCwd = null;
    let seenArgs = null;
    let seenSettings = null;
    const result = await runGeminiReview(
      repo,
      { prompt: "p", engine: "agy", deep: false },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: (_bin, args, opts) => {
          seenArgs = args;
          seenCwd = opts.cwd;
          const idx = args.indexOf("--settings");
          assert.notEqual(idx, -1, "AGY supporting --settings must receive --settings");
          seenSettings = JSON.parse(fs.readFileSync(args[idx + 1], "utf8"));
          assert.equal(fs.readdirSync(opts.cwd).length, 0, "isolated cwd must start empty");
          fs.writeFileSync(path.join(repo, "rogue.txt"), "x", "utf8");
          return { status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" };
        }
      }
    );

    assert.notEqual(seenCwd, repo);
    assert.ok(!seenArgs.includes("--add-dir"));
    assert.ok(seenSettings.permissions.deny.includes("read_file(*)"));
    assert.ok(seenSettings.permissions.deny.includes("write_file(*)"));
    assert.equal(result.agyProtection?.settingsCapable, true);
    assert.equal(result.agyProtection?.settingsPassed, true);
    assert.equal(result.agyProtection?.initObserved, false);
    assert.equal(result.agyProtection?.initPermissionModeMatches, false, "plain JSON envelope lacks init event");
    assert.equal(result.agyProtection?.degradedReason, "stream-json init event not observed");
    assert.equal(result.agyProtection?.denialTelemetryAvailable, false);
    assert.equal(result.agyProtection?.deniedToolsObserved, false);
    assert.equal(result.agyProtection?.customizationCheck, "not-applicable-isolated-cwd");
    assert.equal(result.agyProtection?.customizationCheckScope, "isolated-cwd");
    assert.equal(result.agyProtection?.mode, "review-diff");
    assert.equal(result.agyProtection?.isolatedCwd, true);
    assert.deepEqual(result.readOnlyWrites, ["rogue.txt"]);
    assert.equal(fs.existsSync(seenCwd), false, "isolated cwd must be cleaned up");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("AGY deep review and turn fail closed on workspace customizations unless allowRepoHooks is set", async () => {
  const repo = tempRepo();
  try {
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "hooks.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n", "utf8");

    await assert.rejects(
      runGeminiTurn(
        repo,
        { prompt: "p", write: false, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => {
            throw new Error("should not spawn");
          }
        }
      ),
      /\.agents\/hooks\.json[\s\S]*--allow-repo-hooks/
    );

    await assert.rejects(
      runGeminiReview(
        repo,
        { prompt: "p", engine: "agy", deep: true },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => {
            throw new Error("should not spawn");
          }
        }
      ),
      /\.agents\/hooks\.json[\s\S]*--allow-repo-hooks/
    );

    let turnSettings = null;
    const allowedTurn = await runGeminiTurn(
      repo,
      { prompt: "p", write: false, engine: "agy", allowRepoHooks: true },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: (_bin, args) => {
          const idx = args.indexOf("--settings");
          turnSettings = JSON.parse(fs.readFileSync(args[idx + 1], "utf8"));
          return {
            status: 0,
            stdout: [
              '{"event":"init","conversation_id":"c1","init":{"permission_mode":"request-review"}}',
              '{"event":"step_update","step_update":{"conversation_id":"c1","step_index":1,"state":"ERROR","step_type":"tool","tool_name":"write_file","tool_info":{"error":"Permission denied for write_file(x.txt) by policy"}}}',
              `{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"Done."}}`
            ].join("\n"),
            stderr: ""
          };
        }
      }
    );

    assert.ok(turnSettings.permissions.deny.includes("write_file(*)"));
    assert.ok(turnSettings.permissions.deny.includes("read_file(.env)"));
    assert.equal(allowedTurn.agyProtection?.settingsCapable, true);
    assert.equal(allowedTurn.agyProtection?.settingsPassed, true);
    assert.equal(allowedTurn.agyProtection?.initObserved, true);
    assert.equal(allowedTurn.agyProtection?.initPermissionModeMatches, true);
    assert.equal(allowedTurn.agyProtection?.degradedReason, null);
    assert.equal(allowedTurn.agyProtection?.denialTelemetryAvailable, true);
    assert.equal(allowedTurn.agyProtection?.deniedToolsObserved, true);
    assert.equal(allowedTurn.agyProtection?.customizationCheck, "allowed-with-flag");
    assert.equal(allowedTurn.agyProtection?.customizationCheckScope, "repo-root");
    assert.equal(allowedTurn.agyProtection?.secretScanComplete, true);
    assert.equal(allowedTurn.agyProtection?.secretScanRootScanned, true);
    assert.equal(allowedTurn.agyProtection?.secretScanReadErrors, 0);
    assert.equal(allowedTurn.agyProtection?.mode, "read-only");
    assert.equal(allowedTurn.agyProtection?.initPermissionMode, "request-review");
    assert.equal(allowedTurn.agyProtection?.streamObserved, true);
    assert.equal(allowedTurn.deniedTools?.total, 1);
    assert.match(allowedTurn.deniedToolsNotice, /write_file/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("executeReviewRun and executeTaskRun surface agyProtection and deniedTools banners cleanly", async () => {
  const repo = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, "app.js"), "console.log(1);\n", "utf8");
    const streamOut = (response) => [
      '{"event":"init","conversation_id":"c-exec","init":{"permission_mode":"request-review"}}',
      '{"event":"step_update","step_update":{"conversation_id":"c-exec","step_index":1,"state":"ERROR","step_type":"tool","tool_name":"command","tool_info":{"error":"Permission denied for command(rm) by policy"}}}',
      JSON.stringify({ event: "result", result: { conversation_id: "c-exec", status: "SUCCESS", response } })
    ].join("\n");

    const reviewRes = await executeReviewRun(
      { cwd: repo, engine: "agy", scope: "working-tree", deep: false },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => ({ status: 0, stdout: streamOut(REVIEW_JSON), stderr: "" })
      }
    );
    assert.equal(reviewRes.payload.agyProtection?.mode, "review-diff");
    assert.equal(reviewRes.payload.agyProtection?.initPermissionModeMatches, true);
    assert.equal(reviewRes.payload.agyProtection?.streamObserved, true);
    assert.equal(reviewRes.payload.deniedTools?.total, 1);
    assert.match(reviewRes.rendered, /^> 🛡️ /);

    const taskRes = await executeTaskRun(
      { cwd: repo, engine: "agy", prompt: "inspect", write: false },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => ({ status: 0, stdout: streamOut("Checked."), stderr: "" })
      }
    );
    assert.equal(taskRes.payload.agyProtection?.mode, "read-only");
    assert.equal(taskRes.payload.agyProtection?.initPermissionModeMatches, true);
    assert.equal(taskRes.payload.deniedTools?.total, 1);
    assert.match(taskRes.rendered, /^> ⚠️ .*AGY blocked 1 tool call/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("AGY write:true, legacy diff review isolation, and resume workspace gate/checks behave accurately", async () => {
  const repo = tempRepo();
  try {
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n", "utf8");
    let writeSettings = null;
    const writeTurn = await runGeminiTurn(
      repo,
      { prompt: "p", write: true, engine: "agy" },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: (_bin, args) => {
          const idx = args.indexOf("--settings");
          assert.notEqual(idx, -1);
          writeSettings = JSON.parse(fs.readFileSync(args[idx + 1], "utf8"));
          return {
            status: 0,
            stdout: [
              `{"event":"init","conversation_id":"c-w","init":{"cwd":${JSON.stringify(repo)},"permission_mode":"default"}}`,
              '{"event":"result","result":{"conversation_id":"c-w","status":"SUCCESS","response":"Done."}}'
            ].join("\n"),
            stderr: ""
          };
        }
      }
    );
    assert.ok(!writeSettings.permissions.deny.includes("command(*)"));
    assert.ok(writeSettings.permissions.deny.includes("write_file(.git/)"));
    assert.ok(writeSettings.permissions.deny.includes("read_file(.env)"));
    assert.equal(writeTurn.agyProtection?.mode, "write");
    assert.equal(writeTurn.agyProtection?.settingsPassed, true);
    assert.equal(writeTurn.agyProtection?.initPermissionModeMatches, null);
    assert.equal(writeTurn.agyProtection?.degradedReason, null);
    assert.equal(writeTurn.agyProtection?.deniedToolsObserved, false);

    // Legacy AGY diff review still isolates cwd even without --settings
    let legacyReviewCwd = null;
    let legacyReviewArgs = null;
    const legacyReview = await runGeminiReview(
      repo,
      { prompt: "p", engine: "agy", deep: false },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.12", supportsSettings: false }),
        runCommandFn: (_bin, args, opts) => {
          legacyReviewArgs = args;
          legacyReviewCwd = opts.cwd;
          return { status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" };
        }
      }
    );
    assert.notEqual(legacyReviewCwd, repo);
    assert.ok(!legacyReviewArgs.includes("--settings"));
    assert.equal(legacyReview.agyProtection?.isolatedCwd, true);
    assert.equal(legacyReview.agyProtection?.settingsPassed, false);
    assert.equal(legacyReview.agyProtection?.mode, "none");

    // Non-directory cwd fails closed without advising --allow-repo-hooks
    const pkgFile = path.join(repo, "not-a-dir.txt");
    fs.writeFileSync(pkgFile, "x", "utf8");
    await assert.rejects(
      runGeminiTurn(pkgFile, { prompt: "p", write: false, engine: "agy" }, {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => { throw new Error("should not spawn"); }
      }),
      (err) => {
        assert.match(err.message, /not a directory/);
        assert.doesNotMatch(err.message, /--allow-repo-hooks/);
        return true;
      }
    );

    // Write resume without verified workspace binding fails closed pre-spawn
    await assert.rejects(
      runGeminiTurn(repo, { prompt: "continue", write: true, engine: "agy", resumeLast: true, resumeThreadId: "c-unverified" }, {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => { throw new Error("should not spawn"); }
      }),
      /without verified workspace binding/
    );

    // Verified write resume succeeds with matching cwd
    const verifiedResume = await runGeminiTurn(
      repo,
      { prompt: "continue", write: true, engine: "agy", resumeLast: true, resumeThreadId: "c-ok", resumeWorkspaceVerified: true },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => ({
          status: 0,
          stdout: [
            `{"event":"init","conversation_id":"c-ok","init":{"cwd":${JSON.stringify(repo)},"permission_mode":"always-proceed"}}`,
            '{"event":"result","result":{"conversation_id":"c-ok","status":"SUCCESS","response":"Resumed."}}'
          ].join("\n"),
          stderr: ""
        })
      }
    );
    assert.equal(verifiedResume.agyProtection?.resumedWorkspaceCoverage, "verified-from-job-store");
    assert.equal(verifiedResume.resumeWorkspaceNotice ?? null, null);

    // Resumed turn missing init.cwd invents no mismatch notice
    const missingInitCwd = await runGeminiTurn(
      repo,
      { prompt: "continue", write: false, engine: "agy", resumeLast: true, resumeThreadId: "c-no-cwd" },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
        runCommandFn: () => ({
          status: 0,
          stdout: [
            '{"event":"init","conversation_id":"c-no-cwd","init":{"permission_mode":"request-review"}}',
            '{"event":"result","result":{"conversation_id":"c-no-cwd","status":"SUCCESS","response":"Resumed."}}'
          ].join("\n"),
          stderr: ""
        })
      }
    );
    assert.equal(missingInitCwd.resumeWorkspaceNotice ?? null, null);

    const otherDir = tempRepo();
    try {
      const resumed = await runGeminiTurn(
        repo,
        { prompt: "continue", write: false, engine: "agy", resumeLast: true, resumeThreadId: "c-prev" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => ({
            status: 0,
            stdout: [
              `{"event":"init","conversation_id":"c-prev","init":{"cwd":${JSON.stringify(otherDir)},"permission_mode":"request-review"}}`,
              '{"event":"result","result":{"conversation_id":"c-prev","status":"SUCCESS","response":"Resumed."}}'
            ].join("\n"),
            stderr: ""
          })
        }
      );
      assert.equal(resumed.agyProtection?.resumedWorkspaceUnverified, true);
      assert.equal(resumed.agyProtection?.initCwd, otherDir);
      assert.match(resumed.resumeWorkspaceNotice, /reported working directory/);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }

    // Legacy AGY deep review omits --settings and does not isolate cwd
    let legacyDeepCwd = null;
    let legacyDeepArgs = null;
    const legacyDeep = await runGeminiReview(
      repo,
      { prompt: "p", engine: "agy", deep: true },
      {
        detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.1.12", supportsSettings: false }),
        runCommandFn: (_bin, args, opts) => {
          legacyDeepCwd = opts.cwd;
          legacyDeepArgs = args;
          return { status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" };
        }
      }
    );
    assert.equal(legacyDeepCwd, repo);
    assert.ok(!legacyDeepArgs.includes("--settings"));
    assert.equal(legacyDeep.agyProtection?.isolatedCwd, false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("executeTaskRun derives AGY resume workspace binding from stored job observedWorkspaceCwd", async () => {
  const repo = tempRepo();
  const otherDir = tempRepo();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ro-job-data-"));
  const prevData = process.env.GEMINI_COMPANION_DATA;
  const prevPluginData = process.env.CLAUDE_PLUGIN_DATA;
  const prevSession = process.env.GEMINI_COMPANION_SESSION_ID;
  process.env.GEMINI_COMPANION_DATA = dataDir;
  delete process.env.CLAUDE_PLUGIN_DATA;
  process.env.GEMINI_COMPANION_SESSION_ID = "sess-resume-bind";
  try {
    const fakeDeps = (initCwd, convId, initConvId = convId) => ({
      detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
      runCommandFn: () => ({
        status: 0,
        stdout: [
          `{"event":"init","conversation_id":${JSON.stringify(initConvId)},"init":{"cwd":${JSON.stringify(initCwd)},"permission_mode":"always-proceed"}}`,
          `{"event":"result","result":{"conversation_id":${JSON.stringify(convId)},"status":"SUCCESS","response":"Done."}}`
        ].join("\n"),
        stderr: ""
      })
    });

    // Case 1: first task reports mismatched init.cwd -> persists workspaceMismatch:true and write resume MUST fail closed pre-spawn
    const badJob = {
      id: "job-mismatch-1",
      kind: "task",
      jobClass: "task",
      title: "Bad bind",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, badJob);
    writeJobFile(repo, badJob.id, badJob);
    const badExec = await runTrackedJob(badJob, () =>
      executeTaskRun({ cwd: repo, jobId: badJob.id, prompt: "first", write: true, engine: "agy" }, fakeDeps(otherDir, "conv-bad"))
    );
    assert.equal(badExec.payload.agyProtection?.workspaceMismatch, true);
    const storedBadJob = readJobFile(resolveJobFile(repo, badJob.id));
    assert.equal(storedBadJob.workspaceMismatch, true);

    await assert.rejects(
      executeTaskRun(
        { cwd: repo, prompt: "continue", write: true, resumeLast: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => { throw new Error("should not spawn"); }
        }
      ),
      /without verified workspace binding/
    );

    // Case 2: legacy stored job with no observedWorkspaceCwd -> write resume fails closed pre-spawn
    const legacyNoCwdJob = {
      id: "job-legacy-nocwd",
      kind: "task",
      jobClass: "task",
      title: "Legacy no cwd",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "completed",
      threadId: "conv-legacy-nocwd",
      completedAt: new Date().toISOString()
    };
    upsertJob(repo, legacyNoCwdJob);
    writeJobFile(repo, legacyNoCwdJob.id, legacyNoCwdJob);
    await assert.rejects(
      executeTaskRun(
        { cwd: repo, prompt: "continue", write: true, resumeLast: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => { throw new Error("should not spawn"); }
        }
      ),
      /without verified workspace binding/
    );

    // Case 3: init.conversation_id disagrees with terminal result.conversation_id -> initCwd is NOT bound and resume fails closed
    const splitConvJob = {
      id: "job-split-conv",
      kind: "task",
      jobClass: "task",
      title: "Split conv",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, splitConvJob);
    writeJobFile(repo, splitConvJob.id, splitConvJob);
    const splitExec = await runTrackedJob(splitConvJob, () =>
      executeTaskRun(
        { cwd: repo, jobId: splitConvJob.id, prompt: "split", write: true, engine: "agy" },
        fakeDeps(repo, "conv-terminal", "conv-other-init")
      )
    );
    assert.equal(splitExec.payload.agyProtection?.initCwd, null);
    assert.equal(splitExec.payload.agyProtection?.initConversationMismatch, true);
    assert.equal(splitExec.payload.agyProtection?.workspaceMismatch, true);
    const storedSplitJob = readJobFile(resolveJobFile(repo, splitConvJob.id));
    assert.equal(storedSplitJob.observedWorkspaceCwd, null);
    assert.equal(storedSplitJob.workspaceMismatch, true);
    await assert.rejects(
      executeTaskRun(
        { cwd: repo, prompt: "continue", write: true, resumeLast: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => { throw new Error("should not spawn"); }
        }
      ),
      /without verified workspace binding/
    );

    // Case 4: relative init.cwd cannot satisfy binding -> initCwd is null, workspaceMismatch is true, resume fails closed
    const relCwdJob = {
      id: "job-rel-cwd",
      kind: "task",
      jobClass: "task",
      title: "Relative cwd",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, relCwdJob);
    writeJobFile(repo, relCwdJob.id, relCwdJob);
    const relExec = await runTrackedJob(relCwdJob, () =>
      executeTaskRun({ cwd: repo, jobId: relCwdJob.id, prompt: "rel", write: true, engine: "agy" }, fakeDeps("relative/subdir", "conv-rel"))
    );
    assert.equal(relExec.payload.agyProtection?.initCwd, null);
    assert.equal(relExec.payload.agyProtection?.workspaceMismatch, true);
    await assert.rejects(
      executeTaskRun(
        { cwd: repo, prompt: "continue", write: true, resumeLast: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => { throw new Error("should not spawn"); }
        }
      ),
      /without verified workspace binding/
    );

    // Case 5: cross-event init mixing & outer/inner conflict & missing-cwd conflict fail closed
    const crossMixJob = {
      id: "job-cross-mix",
      kind: "task",
      jobClass: "task",
      title: "Cross mix",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, crossMixJob);
    writeJobFile(repo, crossMixJob.id, crossMixJob);
    const crossMixExec = await runTrackedJob(crossMixJob, () =>
      executeTaskRun(
        { cwd: repo, jobId: crossMixJob.id, prompt: "mix", write: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => ({
            status: 0,
            stdout: [
              `{"event":"init","init":{"cwd":${JSON.stringify(repo)}}}`,
              '{"event":"init","conversation_id":"conv-mix-2","init":{}}',
              '{"event":"result","result":{"conversation_id":"conv-mix-2","status":"SUCCESS","response":"Done."}}'
            ].join("\n"),
            stderr: ""
          })
        }
      )
    );
    assert.equal(crossMixExec.payload.agyProtection?.initCwd, null);
    assert.equal(crossMixExec.payload.agyProtection?.initConversationMismatch, true);
    assert.equal(crossMixExec.payload.agyProtection?.workspaceMismatch, true);

    const outerInnerJob = {
      id: "job-outer-inner-conflict",
      kind: "task",
      jobClass: "task",
      title: "Outer inner conflict",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, outerInnerJob);
    writeJobFile(repo, outerInnerJob.id, outerInnerJob);
    const outerInnerExec = await runTrackedJob(outerInnerJob, () =>
      executeTaskRun(
        { cwd: repo, jobId: outerInnerJob.id, prompt: "outer-inner", write: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => ({
            status: 0,
            stdout: [
              `{"event":"init","conversation_id":"conv-outer","init":{"conversation_id":"conv-inner","cwd":${JSON.stringify(repo)}}}`,
              '{"event":"result","result":{"conversation_id":"conv-outer","status":"SUCCESS","response":"Done."}}'
            ].join("\n"),
            stderr: ""
          })
        }
      )
    );
    assert.equal(outerInnerExec.payload.agyProtection?.initCwd, null);
    assert.equal(outerInnerExec.payload.agyProtection?.initConversationMismatch, true);
    assert.equal(outerInnerExec.payload.agyProtection?.workspaceMismatch, true);

    const conflictNoCwdJob = {
      id: "job-conflict-nocwd",
      kind: "task",
      jobClass: "task",
      title: "Conflict no cwd",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, conflictNoCwdJob);
    writeJobFile(repo, conflictNoCwdJob.id, conflictNoCwdJob);
    const conflictNoCwdExec = await runTrackedJob(conflictNoCwdJob, () =>
      executeTaskRun(
        { cwd: repo, jobId: conflictNoCwdJob.id, prompt: "conflict-nocwd", write: true, engine: "agy" },
        fakeDeps(null, "conv-terminal-2", "conv-init-2")
      )
    );
    assert.equal(conflictNoCwdExec.payload.agyProtection?.initCwd, null);
    assert.equal(conflictNoCwdExec.payload.agyProtection?.initConversationMismatch, true);
    assert.equal(conflictNoCwdExec.payload.agyProtection?.workspaceMismatch, true);
    const storedConflictNoCwd = readJobFile(resolveJobFile(repo, conflictNoCwdJob.id));
    assert.equal(storedConflictNoCwd.workspaceMismatch, true);

    // Case 6: newer task reports matching init.cwd for same conversation -> write resume succeeds with verified binding
    const goodJob = {
      id: "job-match-2",
      kind: "task",
      jobClass: "task",
      title: "Good bind",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, goodJob);
    writeJobFile(repo, goodJob.id, goodJob);
    await runTrackedJob(goodJob, () =>
      executeTaskRun({ cwd: repo, jobId: goodJob.id, prompt: "second", write: true, engine: "agy" }, fakeDeps(repo, "conv-good"))
    );

    const resumed = await executeTaskRun(
      { cwd: repo, prompt: "continue", write: true, resumeLast: true, engine: "agy" },
      fakeDeps(repo, "conv-good")
    );
    assert.equal(resumed.payload.agyProtection?.resumedWorkspaceCoverage, "verified-from-job-store");

    // Case 6b: newer FAILED job via runTrackedJob for same threadId with mismatched init.cwd blocks resume of older completed job
    await new Promise((resolve) => setTimeout(resolve, 15));
    const newerFailedMismatchJob = {
      id: "job-newer-failed-mismatch",
      kind: "task",
      jobClass: "task",
      title: "Newer failed mismatch",
      workspaceRoot: repo,
      sessionId: "sess-resume-bind",
      engine: "agy",
      status: "queued"
    };
    upsertJob(repo, newerFailedMismatchJob);
    writeJobFile(repo, newerFailedMismatchJob.id, newerFailedMismatchJob);
    await runTrackedJob(newerFailedMismatchJob, () =>
      executeTaskRun(
        { cwd: repo, jobId: newerFailedMismatchJob.id, prompt: "fail-mismatch", write: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => ({
            status: 1,
            stdout: [
              `{"event":"init","conversation_id":"conv-good","init":{"cwd":${JSON.stringify(otherDir)},"permission_mode":"always-proceed"}}`,
              '{"event":"result","result":{"conversation_id":"conv-good","status":"ERROR","response":"","error":"failed turn"}}'
            ].join("\n"),
            stderr: ""
          })
        }
      )
    );
    const storedFailedMismatch = readJobFile(resolveJobFile(repo, newerFailedMismatchJob.id));
    assert.equal(storedFailedMismatch.status, "failed");
    assert.equal(storedFailedMismatch.workspaceMismatch, true);
    await assert.rejects(
      executeTaskRun(
        { cwd: repo, prompt: "continue", write: true, resumeLast: true, engine: "agy" },
        {
          detectEngineFn: () => ({ engine: "agy", binary: "/fake/agy.exe", version: "1.5.16", supportsSettings: true }),
          runCommandFn: () => { throw new Error("should not spawn"); }
        }
      ),
      /without verified workspace binding/
    );

    // Case 7: probe-failed degradedReason, write-task progress warnings, & policyLocked read-only fallback wording
    const writeProbeFailedMessages = [];
    const writeProbeFailed = await executeTaskRun(
      {
        cwd: repo,
        prompt: "edit",
        write: true,
        engine: "agy",
        onProgress: (ev) => writeProbeFailedMessages.push(ev.message ?? String(ev))
      },
      {
        detectEngineFn: () => ({
          engine: "agy",
          binary: "/fake/agy.exe",
          version: "1.5.16",
          supportsSettings: false,
          settingsSupportStatus: "probe-failed"
        }),
        runCommandFn: () => ({
          status: 0,
          stdout: '{"event":"result","result":{"conversation_id":"c-wpf","status":"SUCCESS","response":"Done."}}',
          stderr: ""
        })
      }
    );
    assert.equal(writeProbeFailed.payload.agyProtection?.settingsSupportStatus, "probe-failed");
    assert.ok(writeProbeFailedMessages.some((m) => /AGY --help probe failed[\s\S]*\.git\/ and secret-file rules are inactive/.test(m)));

    const writeUnsupportedMessages = [];
    await executeTaskRun(
      {
        cwd: repo,
        prompt: "edit",
        write: true,
        engine: "agy",
        onProgress: (ev) => writeUnsupportedMessages.push(ev.message ?? String(ev))
      },
      {
        detectEngineFn: () => ({
          engine: "agy",
          binary: "/fake/agy.exe",
          version: "1.5.16",
          supportsSettings: false,
          settingsSupportStatus: "unsupported"
        }),
        runCommandFn: () => ({
          status: 0,
          stdout: '{"event":"result","result":{"conversation_id":"c-wunsup","status":"SUCCESS","response":"Done."}}',
          stderr: ""
        })
      }
    );
    assert.ok(writeUnsupportedMessages.some((m) => /does not advertise --settings; \.git\/ and secret-file rules are inactive/.test(m)));

    const probeFailedReview = await runGeminiReview(
      repo,
      { prompt: "p", engine: "agy", deep: true },
      {
        detectEngineFn: () => ({
          engine: "agy",
          binary: "/fake/agy.exe",
          version: "1.5.16",
          supportsSettings: false,
          settingsSupportStatus: "probe-failed"
        }),
        runCommandFn: () => ({ status: 0, stdout: reviewEnvelope(REVIEW_JSON), stderr: "" })
      }
    );
    assert.equal(probeFailedReview.agyProtection?.settingsSupportStatus, "probe-failed");
    assert.equal(
      probeFailedReview.agyProtection?.degradedReason,
      "agy --help probe failed; --settings support could not be verified"
    );
    const lockedUncomparable = describeReadOnlyWrites(
      { checked: false, written: [], reason: "not a git repository" },
      { policyLocked: true }
    );
    assert.match(lockedUncomparable, /could not be compared/);
    assert.doesNotMatch(lockedUncomparable, /no enforced read-only mode/);
  } finally {
    if (prevData == null) delete process.env.GEMINI_COMPANION_DATA;
    else process.env.GEMINI_COMPANION_DATA = prevData;
    if (prevPluginData == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prevPluginData;
    if (prevSession == null) delete process.env.GEMINI_COMPANION_SESSION_ID;
    else process.env.GEMINI_COMPANION_SESSION_ID = prevSession;
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(otherDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
