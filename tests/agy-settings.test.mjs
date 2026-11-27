import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgySettingsPayload,
  collectWorkspaceSecretDenyRules,
  encodeAgyPathRule,
  inspectWorkspaceCustomizations,
  withAgyTempContext
} from "../plugins/gemini/scripts/lib/agy-settings.mjs";
import { initGitRepo } from "./helpers.mjs";

function tempDir(prefix = "agy-settings-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("encodeAgyPathRule normalizes slashes on Windows, rejects POSIX backslashes, traversal, parens, and control chars", () => {
  assert.equal(
    encodeAgyPathRule("read_file", "./config\\.env"),
    process.platform === "win32" ? "read_file(config/.env)" : null
  );
  assert.equal(encodeAgyPathRule("read_file", ".env/"), "read_file(.env)");
  assert.equal(encodeAgyPathRule("read_file", ""), null);
  assert.equal(encodeAgyPathRule("read_file", "../outside/.env"), null);
  assert.equal(encodeAgyPathRule("read_file", "/etc/.env"), null);
  assert.equal(encodeAgyPathRule("read_file", "C:/repo/.env"), null);
  assert.equal(encodeAgyPathRule("read_file", "dir/sub/../.env"), null);
  assert.equal(encodeAgyPathRule("read_file", "bad(name).env"), null);
  assert.equal(encodeAgyPathRule("read_file", "bad\u0000name.env"), null);
  assert.equal(encodeAgyPathRule("", ".env"), null);
});

test("collectWorkspaceSecretDenyRules emits baseline and gitignored workspace secrets while honoring caps", () => {
  const repo = tempDir("agy-secrets-");
  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env\nconfig/\nkeys/\n", "utf8");
    fs.writeFileSync(path.join(repo, ".env"), "API_KEY=secret\n", "utf8");
    fs.mkdirSync(path.join(repo, "config"), { recursive: true });
    fs.writeFileSync(path.join(repo, "config", "prod.env"), "SECRET=1\n", "utf8");
    fs.mkdirSync(path.join(repo, "keys"), { recursive: true });
    fs.writeFileSync(path.join(repo, "keys", "id_ed25519"), "PRIVATE\n", "utf8");
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", ".env"), "IGNORED=1\n", "utf8");
    fs.writeFileSync(path.join(repo, "evil(1).env"), "UNSAFE=1\n", "utf8");

    const scanned = collectWorkspaceSecretDenyRules(repo);
    assert.equal(scanned.truncated, false);
    assert.equal(scanned.budgetExhausted, false);
    assert.equal(scanned.depthTruncated, false);
    assert.equal(scanned.readErrors, 0);
    assert.equal(scanned.skippedSymlinkDirs, 0);
    assert.equal(scanned.symlinkErrors, 0);
    assert.equal(scanned.skippedUnsafeNames, 1);
    assert.ok(scanned.rules.includes("read_file(.env)"));
    assert.ok(scanned.rules.includes("read_file(.netrc)"));
    assert.ok(scanned.rules.includes("read_file(config/prod.env)"));
    assert.ok(scanned.rules.includes("read_file(keys/id_ed25519)"));
    assert.ok(!scanned.rules.includes("read_file(node_modules/pkg/.env)"));

    const aDeep = path.join(repo, "a_deep", "l1", "l2");
    const mShallow = path.join(repo, "m_shallow");
    const zDeep = path.join(repo, "z_deep", "l1", "l2");
    fs.mkdirSync(aDeep, { recursive: true });
    fs.mkdirSync(mShallow, { recursive: true });
    fs.mkdirSync(zDeep, { recursive: true });
    fs.writeFileSync(path.join(aDeep, "too-deep-a.env"), "X=1\n", "utf8");
    fs.writeFileSync(path.join(mShallow, "mid.env"), "X=2\n", "utf8");
    fs.writeFileSync(path.join(zDeep, "too-deep-z.env"), "X=3\n", "utf8");
    const depthBounded = collectWorkspaceSecretDenyRules(repo, { maxDepth: 1 });
    assert.equal(depthBounded.depthTruncated, true);
    assert.equal(depthBounded.budgetExhausted, false);
    assert.equal(depthBounded.truncated, true);
    assert.ok(depthBounded.rules.includes("read_file(m_shallow/mid.env)"), "shallow sibling branch must still be scanned regardless of iteration order");

    const bounded = collectWorkspaceSecretDenyRules(repo, { maxEntries: 2 });
    assert.equal(bounded.budgetExhausted, true);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.rules.includes("read_file(.env)"), "baseline rules remain intact even when walk truncates");

    const broken = collectWorkspaceSecretDenyRules(path.join(repo, "nonexistent-dir"));
    assert.equal(broken.rootScanned, false);
    assert.equal(broken.readErrors, 1);

    const fileAsRoot = collectWorkspaceSecretDenyRules(path.join(repo, ".env"));
    assert.equal(fileAsRoot.rootScanned, false);
    assert.equal(fileAsRoot.readErrors, 1);

    const rootDenied = collectWorkspaceSecretDenyRules(repo, {
      opendirSyncFn: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
    });
    assert.equal(rootDenied.rootScanned, false);
    assert.equal(rootDenied.readErrors, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("collectWorkspaceSecretDenyRules tracks symlinked directories and broken symlinks", (t) => {
  const repo = tempDir("agy-secrets-links-");
  try {
    initGitRepo(repo);
    fs.mkdirSync(path.join(repo, "config"), { recursive: true });
    try {
      fs.symlinkSync(path.join(repo, "config"), path.join(repo, "dir-link.env"), "dir");
      fs.symlinkSync(path.join(repo, "missing-target"), path.join(repo, "broken.env"), "file");
    } catch (error) {
      if (error?.code === "EPERM" || error?.code === "EACCES") {
        t.skip("symlink creation requires elevated privilege on this host");
        return;
      }
      throw error;
    }
    const withLinks = collectWorkspaceSecretDenyRules(repo);
    assert.equal(withLinks.skippedSymlinkDirs, 1);
    assert.equal(withLinks.symlinkErrors, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("buildAgySettingsPayload returns distinct hard-fail policies for review-diff, read-only, and write", () => {
  const reviewDiff = buildAgySettingsPayload({ mode: "review-diff", workspaceDir: "D:/repo", secretDenyRules: ["read_file(.env)"] });
  assert.equal(reviewDiff.allowNonWorkspaceAccess, false);
  assert.deepEqual(reviewDiff.trustedWorkspaces, []);
  assert.ok(reviewDiff.permissions.deny.includes("read_file(*)"));
  assert.ok(reviewDiff.permissions.deny.includes("write_file(*)"));
  assert.ok(reviewDiff.permissions.deny.includes("command(*)"));

  const readOnly = buildAgySettingsPayload({
    mode: "read-only",
    workspaceDir: "D:/repo",
    secretDenyRules: ["read_file(.env)", "read_file(.env)", ""]
  });
  assert.equal(readOnly.allowNonWorkspaceAccess, false);
  assert.deepEqual(readOnly.trustedWorkspaces, ["D:/repo"]);
  assert.ok(!readOnly.permissions.deny.includes("read_file(*)"));
  assert.ok(readOnly.permissions.deny.includes("write_file(*)"));
  assert.ok(readOnly.permissions.deny.includes("command(*)"));
  assert.equal(readOnly.permissions.deny.filter((r) => r === "read_file(.env)").length, 1);

  const writeMode = buildAgySettingsPayload({
    mode: "write",
    workspaceDir: "D:/repo",
    secretDenyRules: ["read_file(.env)"]
  });
  assert.deepEqual(writeMode.trustedWorkspaces, ["D:/repo"]);
  assert.ok(!writeMode.permissions.deny.includes("command(*)"));
  assert.ok(writeMode.permissions.deny.includes("write_file(.git/)"));
  assert.ok(writeMode.permissions.deny.includes("read_file(.env)"));
});

test("inspectWorkspaceCustomizations detects auto-loaded repo hooks/configs and reports missing, non-dir, and hop-limit honestly", () => {
  const repo = tempDir("agy-cust-");
  try {
    initGitRepo(repo);
    assert.deepEqual(inspectWorkspaceCustomizations(repo), {
      checked: true,
      missingCwd: false,
      notDirectory: false,
      repoRootStatus: "resolved",
      repoRootResolved: true,
      hopLimitReached: false,
      scope: "repo-root",
      found: [],
      error: null
    });

    const subdir = path.join(repo, "packages", "app");
    fs.mkdirSync(subdir, { recursive: true });
    fs.mkdirSync(path.join(repo, ".agents"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agents", "hooks.json"), "{}\n", "utf8");
    fs.mkdirSync(path.join(subdir, "_agents"), { recursive: true });
    fs.writeFileSync(path.join(subdir, "_agents", "mcp_config.json"), "{}\n", "utf8");
    fs.mkdirSync(path.join(repo, ".agent", "plugins", "demo"), { recursive: true });

    const detected = inspectWorkspaceCustomizations(subdir);
    assert.equal(detected.checked, true);
    assert.equal(detected.repoRootStatus, "resolved");
    assert.equal(detected.repoRootResolved, true);
    assert.equal(detected.hopLimitReached, false);
    assert.equal(detected.scope, "repo-root");
    assert.ok(detected.found.includes(".agents/hooks.json"));
    assert.ok(detected.found.includes("packages/app/_agents/mcp_config.json"));
    assert.ok(detected.found.includes(".agent/plugins"));

    const hopLimited = inspectWorkspaceCustomizations(subdir, { maxParentHops: 2 });
    assert.equal(hopLimited.checked, false);
    assert.equal(hopLimited.hopLimitReached, true);

    const regularFile = path.join(repo, "regular.json");
    fs.writeFileSync(regularFile, "{}\n", "utf8");
    const fileRes = inspectWorkspaceCustomizations(regularFile);
    assert.equal(fileRes.checked, false);
    assert.equal(fileRes.notDirectory, true);
    assert.equal(fileRes.missingCwd, false);

    const plainDir = tempDir("agy-plain-");
    try {
      const plainRes = inspectWorkspaceCustomizations(plainDir);
      assert.equal(plainRes.checked, true);
      assert.equal(plainRes.repoRootStatus, "not-a-git-repo");
      assert.equal(plainRes.scope, "start-dir-only");
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }

    const missing = inspectWorkspaceCustomizations(path.join(repo, "does-not-exist"));
    assert.equal(missing.checked, false);
    assert.equal(missing.missingCwd, true);
    assert.deepEqual(missing.found, []);

    const prevGitDir = process.env.GIT_DIR;
    const prevGitWorkTree = process.env.GIT_WORK_TREE;
    const prevGitCommonDir = process.env.GIT_COMMON_DIR;
    const prevGitCeiling = process.env.GIT_CEILING_DIRECTORIES;
    const prevGitAcross = process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
    try {
      process.env.GIT_DIR = path.join(repo, "missing-git-dir");
      const gitErr = inspectWorkspaceCustomizations(subdir);
      assert.equal(gitErr.checked, false);
      assert.equal(gitErr.repoRootStatus, "error");
      assert.equal(gitErr.scope, "unverified");

      // Even when GIT_DIR points to a real .git dir (where git rev-parse succeeds), fail closed.
      process.env.GIT_DIR = path.join(repo, ".git");
      const validGitDirOverride = inspectWorkspaceCustomizations(subdir);
      assert.equal(validGitDirOverride.checked, false);
      assert.equal(validGitDirOverride.repoRootStatus, "error");
      assert.equal(validGitDirOverride.scope, "unverified");
      assert.match(validGitDirOverride.error, /environment override/i);

      delete process.env.GIT_DIR;
      process.env.GIT_WORK_TREE = repo;
      const workTreeOverride = inspectWorkspaceCustomizations(subdir);
      assert.equal(workTreeOverride.checked, false);
      assert.equal(workTreeOverride.repoRootStatus, "error");
      assert.equal(workTreeOverride.scope, "unverified");

      // Empty-string env overrides (e.g. GIT_COMMON_DIR="") must still fail closed.
      delete process.env.GIT_WORK_TREE;
      process.env.GIT_COMMON_DIR = "";
      const emptyCommonDirOverride = inspectWorkspaceCustomizations(subdir);
      assert.equal(emptyCommonDirOverride.checked, false);
      assert.equal(emptyCommonDirOverride.repoRootStatus, "error");
      assert.equal(emptyCommonDirOverride.scope, "unverified");

      // Discovery-limiting env vars must also fail closed.
      delete process.env.GIT_COMMON_DIR;
      process.env.GIT_CEILING_DIRECTORIES = repo;
      const ceilingOverride = inspectWorkspaceCustomizations(subdir);
      assert.equal(ceilingOverride.checked, false);
      assert.equal(ceilingOverride.repoRootStatus, "error");
      assert.equal(ceilingOverride.scope, "unverified");

      delete process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = "0";
      const acrossOverride = inspectWorkspaceCustomizations(subdir);
      assert.equal(acrossOverride.checked, false);
      assert.equal(acrossOverride.repoRootStatus, "error");
      assert.equal(acrossOverride.scope, "unverified");
    } finally {
      if (prevGitDir == null) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      if (prevGitWorkTree == null) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = prevGitWorkTree;
      if (prevGitCommonDir == null) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = prevGitCommonDir;
      if (prevGitCeiling == null) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = prevGitCeiling;
      if (prevGitAcross == null) delete process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM;
      else process.env.GIT_DISCOVERY_ACROSS_FILESYSTEM = prevGitAcross;
    }

    // Trailing extra lines after ".git" on stderr must NOT classify as not-a-git-repo.
    const multilineGitStderr = inspectWorkspaceCustomizations(subdir, {
      runCommandFn: () => ({
        status: 128,
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\nfatal: extra diagnostic\n"
      })
    });
    assert.equal(multilineGitStderr.checked, false);
    assert.equal(multilineGitStderr.repoRootStatus, "error");
    assert.equal(multilineGitStderr.scope, "unverified");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("withAgyTempContext writes UTF-8 without BOM, isolates cwd, and preserves errors across sync/async cleanup failures", async () => {
  let capturedRoot = null;
  let capturedSettings = null;
  let capturedCwd = null;

  await withAgyTempContext(
    { settingsPayload: { toolPermission: "request-review" }, isolatedCwd: true },
    async ({ tempRoot, settingsFile, isolatedCwdPath }) => {
      capturedRoot = tempRoot;
      capturedSettings = settingsFile;
      capturedCwd = isolatedCwdPath;
      const bytes = fs.readFileSync(settingsFile);
      assert.notEqual(bytes[0], 0xef, "settings.json must never start with a UTF-8 BOM");
      assert.deepEqual(JSON.parse(bytes.toString("utf8")), { toolPermission: "request-review" });
      assert.deepEqual(fs.readdirSync(isolatedCwdPath), []);
    }
  );
  assert.equal(fs.existsSync(capturedRoot), false);
  assert.equal(fs.existsSync(capturedSettings), false);
  assert.equal(fs.existsSync(capturedCwd), false);

  let errorTempRoot = null;
  let cleanupNoticeCalled = false;
  await assert.rejects(
    withAgyTempContext(
      {
        settingsPayload: { a: 1 },
        isolatedCwd: false,
        rmSyncFn: () => {
          throw new Error("rm-failed");
        },
        onCleanupError: () => {
          cleanupNoticeCalled = true;
          throw new Error("callback-failed");
        }
      },
      async ({ tempRoot }) => {
        errorTempRoot = tempRoot;
        throw new Error("preserve-me");
      }
    ),
    /preserve-me/
  );
  assert.equal(cleanupNoticeCalled, true);
  fs.rmSync(errorTempRoot, { recursive: true, force: true });

  let asyncTempRoot = null;
  let unhandledFired = false;
  const onUnhandled = () => {
    unhandledFired = true;
  };
  process.once("unhandledRejection", onUnhandled);
  try {
    const out = await withAgyTempContext(
      {
        settingsPayload: { a: 1 },
        isolatedCwd: false,
        rmSyncFn: () => {
          throw new Error("rm-failed");
        },
        onCleanupError: async () => {
          throw new Error("async-callback-failed");
        }
      },
      async ({ tempRoot }) => {
        asyncTempRoot = tempRoot;
        return "ok";
      }
    );
    assert.equal(out, "ok");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(unhandledFired, false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    if (asyncTempRoot) fs.rmSync(asyncTempRoot, { recursive: true, force: true });
  }
});
