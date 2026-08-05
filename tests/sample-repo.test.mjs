import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "make-sample-repo.mjs");

// The script is a reviewer's entry point: it is what someone with no credentials
// runs to get something safe to point a command at. If it breaks, the offline
// verification path in docs/verifying-without-credentials.md breaks with it.

test("make-sample-repo lists the corpus cases", () => {
  const result = run("node", [SCRIPT, "--list"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /auth-basic/);
});

test("make-sample-repo builds a git repo with a diff and the planted defects", () => {
  const result = run("node", [SCRIPT, "--case", "auth-basic", "--json"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  try {
    assert.equal(report.caseId, "auth-basic");
    assert.ok(fs.existsSync(path.join(report.repoDir, ".git")), "not a git repository");
    assert.ok(report.diffChars > 0, "a review target with no diff is useless");
    assert.ok(report.plantedDefects.length > 0, "the reviewer needs to know what to expect");
    for (const defect of report.plantedDefects) {
      assert.ok(defect.id, "every planted defect needs an id to report against");
    }
  } finally {
    // The script deliberately leaves the repo behind for the human; the test
    // that created one has to clean up after itself.
    fs.rmSync(report.repoDir, { recursive: true, force: true });
  }
});

test("make-sample-repo rejects an unknown case instead of inventing one", () => {
  const result = run("node", [SCRIPT, "--case", "no-such-case"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown case/);
});
