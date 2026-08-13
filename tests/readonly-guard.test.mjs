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
