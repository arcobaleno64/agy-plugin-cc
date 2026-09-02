import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIP = path.join(ROOT, "scripts", "ship.mjs");

// The unit tests cover ship.mjs's pure helpers, and that is precisely how a
// crash on every `--version` run reached a PR: `applyChangelog` fell off the end
// returning undefined, `main` spread it, and nothing that imported a function
// ever executed that path. These tests run the script as a process against a
// throwaway git repository, which is the only thing that would have caught it.
//
// Scope: the steps before the network. Each run passes --no-push, so nothing
// here contacts origin or gh.

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ship-release-"));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Windows can still hold a handle; temp is reclaimed by the OS.
    }
  });
  git(dir, "init", "-q", "-b", "work");
  git(dir, "config", "user.email", "ship-test@example.invalid");
  git(dir, "config", "user.name", "ship test");
  // Only what ship touches before the gates: a changelog to insert into, and a
  // file to stand in for the caller's own staged change.
  fs.mkdirSync(path.join(dir, "plugins", "gemini"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "plugins", "gemini", "CHANGELOG.md"),
    "# Changelog\n\n## 0.1.0 - 2026-01-01 - First\n\n- something\n",
    "utf8"
  );
  fs.writeFileSync(path.join(dir, "code.txt"), "before\n", "utf8");
  // Stand-ins for the project's own tooling, so the release path can be run to
  // the end. They assert nothing; what is under test is ship's sequencing --
  // that it bumps before it gates, and stages what it wrote before it commits.
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({
    name: "ship-release-fixture",
    version: "0.1.0",
    private: true,
    scripts: {
      test: "node -e \"console.log('ℹ tests 1\\\\nℹ pass 1\\\\nℹ fail 0')\"",
      "check-version": "node -e \"console.log('ok')\"",
      "verify-contracts": "node -e \"console.log('ok')\""
    }
  }, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "bump-version.mjs"), [
    "import fs from 'node:fs';",
    "const version = process.argv[2];",
    "if (process.argv.includes('--list-targets')) { console.log('package.json'); process.exit(0); }",
    "const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));",
    // Reports only what it actually changed, exactly as the real bump-version
    // does. A stub that always claims a rewrite hides the retry case, where the
    // manifests already hold the target version and the report is empty.
    "const changed = pkg.version !== version;",
    "pkg.version = version;",
    "if (changed) fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\\n`);",
    "console.log(`Set version metadata to ${version}: ${changed ? 'package.json' : 'no files changed'}.`);"
  ].join("\n"), "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  fs.writeFileSync(path.join(dir, ".ship-commit"), "chore: a commit\n", "utf8");
  fs.writeFileSync(path.join(dir, ".ship-changelog"), "## 0.2.0 - 2026-02-02 - Second\n\n- a new thing\n", "utf8");
  return dir;
}

function ship(dir, args) {
  return spawnSync(process.execPath, [SHIP, "--root", dir, ...args], { cwd: dir, encoding: "utf8" });
}

test("a --version dry run reaches the end instead of throwing", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "code.txt"), "after\n", "utf8");
  git(dir, "add", "code.txt");
  const result = ship(dir, [
    "--commit", ".ship-commit", "--changelog", ".ship-changelog", "--version", "0.2.0", "--dry-run", "--no-push"
  ]);
  assert.doesNotMatch(result.stderr, /TypeError|not iterable/, result.stderr);
  assert.match(result.stdout, /== done/, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0);
  // A dry run that edited the file would be a dry run in name only.
  assert.match(fs.readFileSync(path.join(dir, "plugins", "gemini", "CHANGELOG.md"), "utf8"), /^# Changelog\n\n## 0\.1\.0/);
});

// ship stages this list rather than the one a bump reports, so the two must not
// drift: a target missing here is a manifest that silently stays out of release
// commits made on a retry.
test("bump-version --list-targets names every manifest it can rewrite", () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, "scripts", "bump-version.mjs"), "--list-targets"],
    { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const listed = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(listed, [
    "package.json",
    "package-lock.json",
    "plugins/gemini/.claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json"
  ]);
  for (const file of listed) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is listed but does not exist`);
  }
});

test("preflight refuses a detached HEAD before anything is written", (t) => {
  const dir = makeRepo(t);
  git(dir, "checkout", "-q", "--detach");
  const result = ship(dir, ["--commit", ".ship-commit", "--no-push"]);
  assert.equal(result.status, 10);
  assert.match(result.stderr, /detached/i);
});

test("preflight refuses the default branch", (t) => {
  const dir = makeRepo(t);
  git(dir, "branch", "-m", "main");
  const result = ship(dir, ["--commit", ".ship-commit", "--no-push"]);
  assert.equal(result.status, 10);
  assert.match(result.stderr, /main/);
});

test("nothing staged and no version is refused, not committed empty", (t) => {
  const dir = makeRepo(t);
  const result = ship(dir, ["--commit", ".ship-commit", "--no-push"]);
  assert.equal(result.status, 11);
  assert.equal(git(dir, "log", "--oneline").split("\n").length, 1);
});

test("an unstaged change is reported, because the gates test it and the commit will not", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "code.txt"), "staged\n", "utf8");
  git(dir, "add", "code.txt");
  fs.writeFileSync(path.join(dir, "code.txt"), "staged, then edited again\n", "utf8");
  const result = ship(dir, ["--commit", ".ship-commit", "--no-push", "--dry-run"]);
  assert.match(result.stdout, /unstaged change/);
  assert.match(result.stdout, /code\.txt/);
});

test("the changelog entry is staged, so a release commit cannot omit it", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "code.txt"), "after\n", "utf8");
  git(dir, "add", "code.txt");
  // bump-version rewrites only the manifests it reports, never the changelog, and
  // check-version reads the working tree rather than the index -- so if ship does
  // not stage the entry itself, the release commit goes out without it and every
  // gate still passes.
  const result = ship(dir, ["--commit", ".ship-commit", "--changelog", ".ship-changelog", "--version", "0.2.0", "--no-push"]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const committed = git(dir, "show", "--pretty=", "--name-only", "HEAD").split("\n");
  assert.ok(
    committed.includes("plugins/gemini/CHANGELOG.md"),
    `release commit has no changelog entry; it contains: ${committed.join(", ")}`
  );
  assert.ok(committed.includes("package.json"), committed.join(", "));
  assert.ok(committed.includes("code.txt"), "the caller's own staged change must still be in the commit");
});

test("a second run does not insert the same version twice", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "code.txt"), "after\n", "utf8");
  git(dir, "add", "code.txt");
  const args = ["--commit", ".ship-commit", "--changelog", ".ship-changelog", "--version", "0.2.0", "--no-push"];
  ship(dir, args);
  ship(dir, args);
  const changelog = fs.readFileSync(path.join(dir, "plugins", "gemini", "CHANGELOG.md"), "utf8");
  assert.equal(changelog.match(/## 0\.2\.0/g)?.length, 1, changelog);
});

// The retry after a failed gate is the dangerous run, and it is dangerous
// precisely because it looks fine: run 1 wrote the changelog and bumped the
// manifests, then died at a gate, leaving both unstaged. On the retry the
// changelog entry is already present and bump-version reports "no files
// changed", so a script that stages what THIS run wrote stages neither -- and
// every gate still passes, because they read the working tree rather than the
// index. The result is a release commit containing only the caller's code.
test("a retry after a failed gate still commits the release, not just the code", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, "code.txt"), "after\n", "utf8");
  git(dir, "add", "code.txt");
  const args = ["--commit", ".ship-commit", "--changelog", ".ship-changelog", "--version", "0.2.0", "--no-push"];

  const pkg = path.join(dir, "package.json");
  const original = fs.readFileSync(pkg, "utf8");
  const failing = JSON.parse(original);
  failing.scripts.test = "node -e \"process.exit(1)\"";
  fs.writeFileSync(pkg, `${JSON.stringify(failing, null, 2)}\n`, "utf8");

  const first = ship(dir, args);
  assert.equal(first.status, 30, `expected the gate to fail: ${first.stdout}${first.stderr}`);
  assert.equal(git(dir, "log", "--oneline").split("\n").length, 1, "nothing is committed on a failed gate");

  // Repair the gate the way a caller would, leaving run 1's release edits in the
  // tree, and let the version stay bumped as run 1 left it.
  const repaired = JSON.parse(fs.readFileSync(pkg, "utf8"));
  repaired.scripts.test = JSON.parse(original).scripts.test;
  fs.writeFileSync(pkg, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");

  const second = ship(dir, args);
  assert.equal(second.status, 0, `${second.stdout}${second.stderr}`);
  const committed = git(dir, "show", "--pretty=", "--name-only", "HEAD").split("\n");
  assert.ok(committed.includes("plugins/gemini/CHANGELOG.md"), `retry commit lost the changelog: ${committed.join(", ")}`);
  assert.ok(committed.includes("package.json"), `retry commit lost the bump: ${committed.join(", ")}`);
  assert.equal(git(dir, "status", "--porcelain", "plugins/gemini/CHANGELOG.md"), "", "and left nothing behind unstaged");
});

test("--pr with --no-push is refused rather than silently skipped", (t) => {
  const dir = makeRepo(t);
  fs.writeFileSync(path.join(dir, ".ship-pr"), "body\n", "utf8");
  const result = ship(dir, ["--commit", ".ship-commit", "--pr", ".ship-pr", "--no-push"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--no-push/);
});

test("a missing changelog fails with a documented exit code, not a raw ENOENT", (t) => {
  const dir = makeRepo(t);
  fs.rmSync(path.join(dir, "plugins", "gemini", "CHANGELOG.md"));
  const result = ship(dir, ["--commit", ".ship-commit", "--changelog", ".ship-changelog", "--version", "0.2.0", "--no-push"]);
  assert.equal(result.status, 12);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});
