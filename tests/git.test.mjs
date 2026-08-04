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
