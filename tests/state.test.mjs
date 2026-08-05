import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  generateJobId,
  writeJobFile,
  readJobFile
} from "../plugins/gemini/scripts/lib/state.mjs";

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
});

test("resolveStateDir honors GEMINI_COMPANION_DATA when provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.GEMINI_COMPANION_DATA;
  process.env.GEMINI_COMPANION_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  } finally {
    if (previous == null) {
      delete process.env.GEMINI_COMPANION_DATA;
    } else {
      process.env.GEMINI_COMPANION_DATA = previous;
    }
  }
});

// resolveStateDir hashes the *canonicalized* workspace path (fs.realpathSync.native)
// so the same checkout reached through a symlink shares one state dir. Nothing
// covered that before, and it is the reason a job started under one path is
// visible from the other.
test("resolveStateDir canonicalizes the workspace before hashing", (t) => {
  const realParent = makeTempDir();
  const linkParent = makeTempDir();
  const workspace = path.join(realParent, "ws");
  const linked = path.join(linkParent, "ws");
  fs.mkdirSync(workspace);

  try {
    fs.symlinkSync(workspace, linked, "dir");
  } catch (error) {
    if (process.platform === "win32" && (error.code === "EPERM" || error.code === "EACCES")) {
      t.skip("symlink creation not permitted on this Windows host");
      return;
    }
    throw error;
  }

  assert.equal(resolveStateDir(linked), resolveStateDir(workspace));
});

test("resolveStateDir separates two workspaces that share a basename", () => {
  const first = path.join(makeTempDir(), "ws");
  const second = path.join(makeTempDir(), "ws");
  fs.mkdirSync(first);
  fs.mkdirSync(second);

  // The slug is identical; only the path hash keeps their jobs apart.
  assert.notEqual(resolveStateDir(first), resolveStateDir(second));
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return { id: jobId, status: "completed", logFile, updatedAt, createdAt: updatedAt };
  });

  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, config: {}, jobs }, null, 2)}\n`, "utf8");

  saveState(workspace, { version: 1, config: {}, jobs });

  const jobsDir = path.dirname(resolveJobFile(workspace, "job-0"));
  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));

  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-50")), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), false);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-0")), false);
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("generateJobId produces a prefixed id with a crypto-random suffix", () => {
  const id = generateJobId("task");
  assert.match(id, /^task-[0-9a-z]+-[0-9a-f]{10}$/);
  assert.notEqual(generateJobId("task"), generateJobId("task"));
});

test("state and job writes leave parseable JSON", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);

  saveState(workspace, {
    version: 1,
    config: { stopReviewGateEnabled: true },
    jobs: [{ id: "task-1", status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" }]
  });
  const jobFile = writeJobFile(workspace, "task-1", { id: "task-1", status: "completed" });

  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).jobs[0].id, "task-1");
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "completed");
});

// saveState writes to a pid-and-random temp file and renames it into place. The
// guarantee that buys is that a concurrent reader never sees a half-written
// state.json — not that concurrent writers keep each other's jobs, which a
// load/mutate/save cycle cannot promise. Assert the guarantee that exists.
test("concurrent writers never expose a partially written state.json", async () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  // Node 18 has no import.meta.dirname; the repo's other tests resolve paths
  // through the module URL for the same reason.
  const stateModule = new URL("../plugins/gemini/scripts/lib/state.mjs", import.meta.url).href;

  const worker = path.join(workspace, "writer.mjs");
  fs.writeFileSync(
    worker,
    [
      `const { upsertJob } = await import(${JSON.stringify(stateModule)});`,
      "const [workspace, tag] = process.argv.slice(2);",
      "for (let i = 0; i < 12; i += 1) {",
      "  upsertJob(workspace, { id: `${tag}-${i}`, status: 'completed', payload: 'x'.repeat(2048) });",
      "}"
    ].join("\n"),
    "utf8"
  );

  let torn = 0;
  let reads = 0;
  const reading = setInterval(() => {
    let raw;
    try {
      raw = fs.readFileSync(stateFile, "utf8");
    } catch {
      return; // not created yet, or mid-rename on Windows
    }
    reads += 1;
    try {
      JSON.parse(raw);
    } catch {
      torn += 1;
    }
  }, 1);

  try {
    await Promise.all(
      ["a", "b", "c"].map(
        (tag) =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [worker, workspace, tag], { stdio: "ignore" });
            child.on("error", reject);
            child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}`))));
          })
      )
    );
  } finally {
    // Without this on the failure path, the 1 ms interval keeps the event loop
    // alive and the whole test run hangs instead of reporting the failure.
    clearInterval(reading);
  }

  assert.ok(reads > 0, "the reader never observed the state file");
  assert.equal(torn, 0, `observed ${torn} torn reads of state.json`);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(stateFile, "utf8")));

  const leftovers = fs.readdirSync(path.dirname(stateFile)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "temp files were left behind");
});

test("readJobFile fails closed for corrupted job JSON", () => {
  const workspace = makeTempDir();
  const jobFile = resolveJobFile(workspace, "task-corrupt");
  fs.writeFileSync(jobFile, "{ not-json", "utf8");

  const job = readJobFile(jobFile);

  assert.equal(job.id, "task-corrupt");
  assert.equal(job.status, "failed");
  assert.equal(job.failure.category, "invalid-json");
  assert.match(job.errorMessage, /Unreadable job file/i);
});
