import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, formatUntrackedFile, getWorkingTreeState, resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

function commitInitial(cwd) {
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
}

test("resolveReviewTarget prefers the working tree when the repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});
  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to a branch diff when the repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /## Branch Diff/);
  assert.match(context.content, /## Commit Log/);
});

test("resolveReviewTarget honors an explicit base override", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);

  const target = resolveReviewTarget(cwd, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.explicit, true);
});

test("resolveReviewTarget throws when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext includes untracked file content in a working-tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  fs.writeFileSync(path.join(cwd, "new-risk.js"), "const secret = 'UNTRACKED_MARKER';\n");

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.equal(context.mode, "working-tree");
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_MARKER/);
});

test("getWorkingTreeState reflects staged, unstaged, and untracked files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  fs.writeFileSync(path.join(cwd, "untracked.js"), "console.log('new');\n");

  const state = getWorkingTreeState(cwd);
  assert.equal(state.isDirty, true);
  assert.ok(state.unstaged.includes("app.js"));
  assert.ok(state.untracked.includes("untracked.js"));
});

test("resolveReviewTarget rejects an unsafe --base ref", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  assert.throws(() => resolveReviewTarget(cwd, { base: "--upload-pack=evil" }), /Invalid --base ref/);
  assert.throws(() => resolveReviewTarget(cwd, { base: "x; rm -rf /" }), /Invalid --base ref/);
});

test("auto-detected default refs with shell metacharacters stay literal", () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir("gemini-git-ref-probe-");
  const sentinel = path.join(cwd, "shell-injection-sentinel.txt");
  const originalPath = process.env.PATH;
  const originalSentinel = process.env.AGY_REF_SENTINEL;
  const probeName = process.platform === "win32" ? "agyrefprobe.cmd" : "agyrefprobe";
  const probeSource = process.platform === "win32"
    ? "@echo off\r\n> \"%AGY_REF_SENTINEL%\" echo injected\r\n"
    : "#!/bin/sh\nprintf injected > \"$AGY_REF_SENTINEL\"\n";

  writeExecutable(path.join(binDir, probeName), probeSource);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  process.env.AGY_REF_SENTINEL = sentinel;

  try {
    initGitRepo(cwd);
    commitInitial(cwd);
    const mainCommit = run("git", ["rev-parse", "HEAD"], { cwd, shell: false }).stdout.trim();
    assert.ok(mainCommit);
    assert.equal(
      run("git", ["update-ref", "refs/heads/main&agyrefprobe", mainCommit], { cwd, shell: false }).status,
      0
    );
    assert.equal(
      run("git", ["update-ref", "refs/remotes/origin/main&agyrefprobe", mainCommit], { cwd, shell: false }).status,
      0
    );
    assert.equal(
      run(
        "git",
        ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main&agyrefprobe"],
        { cwd, shell: false }
      ).status,
      0
    );

    run("git", ["checkout", "-b", "feature/literal-ref"], { cwd, shell: false });
    fs.writeFileSync(path.join(cwd, "app.js"), "console.log('literal ref');\n");
    run("git", ["add", "app.js"], { cwd, shell: false });
    run("git", ["commit", "-m", "literal ref change"], { cwd, shell: false });

    const target = resolveReviewTarget(cwd, { scope: "branch" });
    const context = collectReviewContext(cwd, target);

    assert.equal(target.baseRef, "main&agyrefprobe");
    assert.match(context.content, /literal ref/);
    assert.equal(fs.existsSync(sentinel), false, "a repository-derived ref must never execute an adjacent command");
  } finally {
    if (originalPath == null) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalSentinel == null) delete process.env.AGY_REF_SENTINEL;
    else process.env.AGY_REF_SENTINEL = originalSentinel;
  }
});

test("formatUntrackedFile skips a directory instead of crashing", () => {
  const cwd = makeTempDir();
  fs.mkdirSync(path.join(cwd, "a-dir"));
  assert.match(formatUntrackedFile(cwd, "a-dir"), /\(skipped: directory\)/);
});

test("formatUntrackedFile inlines a small text file", () => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "note.txt"), "hello content\n");
  const out = formatUntrackedFile(cwd, "note.txt");
  assert.match(out, /### note\.txt/);
  assert.match(out, /hello content/);
});

// Symlink creation needs SeCreateSymbolicLinkPrivilege on Windows (Developer
// Mode or an elevated shell). Report the skip rather than passing silently on a
// machine that never ran the assertion.
function trySymlink(target, linkPath) {
  try {
    fs.symlinkSync(target, linkPath, "file");
    return true;
  } catch (error) {
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
      return false;
    }
    throw error;
  }
}

test("formatUntrackedFile does not read through a symlink that leaves the workspace", (t) => {
  const outside = makeTempDir("gemini-plugin-outside-");
  fs.writeFileSync(path.join(outside, "id_rsa"), "OUTSIDE_KEY_MATERIAL\n");

  const cwd = makeTempDir();
  // The link name is what isSecretFile sees, and an attacker picks it. An
  // innocuous name pointing at key material passed every earlier check.
  if (!trySymlink(path.join(outside, "id_rsa"), path.join(cwd, "notes.txt"))) {
    t.skip("symlink creation not permitted on this Windows host");
    return;
  }

  const out = formatUntrackedFile(cwd, "notes.txt");
  assert.ok(!out.includes("OUTSIDE_KEY_MATERIAL"), "content outside the workspace must not be sent");
  assert.match(out, /\(skipped: symlink resolves outside the workspace\)/);
});

test("formatUntrackedFile still inlines a symlink that stays inside the workspace", (t) => {
  const cwd = makeTempDir();
  fs.writeFileSync(path.join(cwd, "real.txt"), "in-repo content\n");
  if (!trySymlink(path.join(cwd, "real.txt"), path.join(cwd, "alias.txt"))) {
    t.skip("symlink creation not permitted on this Windows host");
    return;
  }

  // The containment check must not turn every symlink into a skip: an in-repo
  // alias is ordinary reviewable content.
  const out = formatUntrackedFile(cwd, "alias.txt");
  assert.match(out, /in-repo content/);
});

test("formatUntrackedFile still reports a broken symlink as broken", (t) => {
  const cwd = makeTempDir();
  if (!trySymlink(path.join(cwd, "missing-target.txt"), path.join(cwd, "dangling.txt"))) {
    t.skip("symlink creation not permitted on this Windows host");
    return;
  }
  assert.match(formatUntrackedFile(cwd, "dangling.txt"), /\(skipped: broken symlink or unreadable file\)/);
});

// docs/THREAT-MODEL.md 7.4 — the review path used to send secret files whole
// while /gemini:transfer redacted them from the same diff.
test("collectReviewContext withholds secret file content from a working-tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, ".env"), "API_KEY=old\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "const a = 1;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  fs.writeFileSync(path.join(cwd, ".env"), "API_KEY=TRACKED_LEAK\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "const a = 2;\n");
  fs.writeFileSync(path.join(cwd, ".env.production"), "TOKEN=UNTRACKED_LEAK\n");

  const context = collectReviewContext(cwd, { mode: "working-tree" });
  const payload = JSON.stringify(context);

  assert.ok(!payload.includes("TRACKED_LEAK"), "a modified secret file must not reach the model");
  assert.ok(!payload.includes("UNTRACKED_LEAK"), "an untracked secret file must not be sent whole");
  assert.ok(payload.includes("const a = 2"), "ordinary code must still be reviewed");
  // The filename survives so the review can still flag that the file changed.
  assert.ok(payload.includes(".env"));
});

// ---------------------------------------------------------------------------
// Review payload budgeting
//
// The defect these pin: the payload was filled front-to-back and cut at 400,000
// characters, so one large file evicted every file after it. Measured on a
// 5,200-line `data/questions.json` edit beside one tracked source change and
// three untracked new files, the whole `## Untracked Files` section and the
// tracked `src/quiz.ts` change (which sorts after `data/`) never reached the
// model — and the review came back `approve`, having seen one file. The only
// signal was a notice sitting at character 400,000 that the model was asked to
// relay, and nothing told the plugin itself that anything had been dropped.
// ---------------------------------------------------------------------------

function seedOversizedChange(cwd, { dataRows = 6000, rationaleWidth = 70 } = {}) {
  fs.mkdirSync(path.join(cwd, "data"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "data", "questions.json"), "[\n]\n");
  fs.writeFileSync(path.join(cwd, "src", "quiz.ts"), "export const scoreQuiz = () => 0;\n");
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "baseline"], { cwd });

  const rows = Array.from(
    { length: dataRows },
    (_, index) => `  { "id": ${index}, "rationale": "${"x".repeat(rationaleWidth)}" }`
  );
  fs.writeFileSync(path.join(cwd, "data", "questions.json"), `[\n${rows.join(",\n")}\n]\n`);
  fs.writeFileSync(path.join(cwd, "src", "quiz.ts"), "export const scoreQuiz = () => {\n  // MARKER_TRACKED\n  return 1;\n};\n");
  fs.writeFileSync(path.join(cwd, "src", "question-pool.ts"), "// MARKER_UNTRACKED_POOL\n");
  fs.writeFileSync(path.join(cwd, "src", "QuestionCard.vue"), "<!-- MARKER_UNTRACKED_CARD -->\n");
  fs.writeFileSync(path.join(cwd, "src", "pool.test.ts"), "// MARKER_UNTRACKED_TEST\n");
}

test("a huge data file cannot evict the code files reviewed alongside it", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  seedOversizedChange(cwd);

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  for (const marker of ["MARKER_TRACKED", "MARKER_UNTRACKED_POOL", "MARKER_UNTRACKED_CARD", "MARKER_UNTRACKED_TEST"]) {
    assert.ok(context.content.includes(marker), `${marker} never reached the model`);
  }
  assert.ok(context.content.includes("## Untracked Files"), "the untracked section was evicted entirely");
  assert.equal(context.truncatedFiles.includes("data/questions.json"), true);
});

test("the caller is told what was truncated, not just the model", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  seedOversizedChange(cwd);

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.equal(context.truncated, true);
  assert.ok(Array.isArray(context.truncatedFiles) && Array.isArray(context.omittedFiles));
  // Stated up front rather than buried at the size limit, where a model that
  // stopped reading early never sees it.
  assert.match(context.content.slice(0, 200), /REVIEW INPUT TRUNCATED/);
});

test("an untruncated review payload is unchanged by budgeting", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitInitial(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  fs.writeFileSync(path.join(cwd, "notes.txt"), "untracked note\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.equal(context.truncated, false);
  assert.deepEqual(context.truncatedFiles, []);
  assert.deepEqual(context.omittedFiles, []);
  assert.equal(context.content.startsWith("## Git Status"), true, "no notice may be added when nothing was cut");
  assert.match(context.content, /console\.log\('v2'\)/);
  assert.match(context.content, /untracked note/);
});

test("the budgeted payload still respects the size cap", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  seedOversizedChange(cwd, { dataRows: 20000, rationaleWidth: 120 });

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.equal(context.truncated, true);
  // The 400,000-character budget, plus the leading notice, which is bounded by
  // the number of names it lists and is the most important text in the payload.
  assert.ok(context.content.length <= 405_000, `payload was ${context.content.length} characters`);
});

// A diff larger than spawnSync's 1 MiB default used to abort the whole review
// with a raw `spawnSync git ENOBUFS` before any budgeting could run.
test("a diff larger than the default spawn buffer is budgeted, not crashed on", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  seedOversizedChange(cwd, { dataRows: 20000, rationaleWidth: 120 });

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.ok(context.content.includes("MARKER_TRACKED"), "the tracked code change was lost");
  assert.equal(context.truncatedFiles.includes("data/questions.json"), true);
});

// Several large files must share the budget rather than be served in order.
// Spending it in order is not merely unfair: with three comparable files and a
// budget for one and a bit, the third receives nothing and drops out of the
// review completely — the same silent omission as the single-huge-file case,
// reached by a different route. Ascending order alone does not prevent this;
// the per-file share is what does.
test("several large files split the budget instead of being served in order", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  const names = ["alpha.json", "bravo.json", "charlie.json"];
  for (const name of names) {
    fs.writeFileSync(path.join(cwd, name), "[]\n");
  }
  run("git", ["add", "-A"], { cwd });
  run("git", ["commit", "-m", "baseline"], { cwd });

  for (const name of names) {
    const rows = Array.from({ length: 2600 }, (_, index) => `  { "id": ${index}, "v": "${"x".repeat(90)}" }`);
    fs.writeFileSync(path.join(cwd, name), `[\n${rows.join(",\n")}\n]\n`);
  }

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.deepEqual(context.omittedFiles, [], "a large file was dropped rather than given its share");
  for (const name of names) {
    assert.ok(context.content.includes(`b/${name}`), `${name} is absent from the review payload`);
  }
});
