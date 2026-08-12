import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  listJobs,
  pruneJobStore,
  removeJobs,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  generateJobId,
  writeJobFile,
  readJobFile
} from "../plugins/gemini/scripts/lib/state.mjs";

// These run inside a Claude Code session more often than not, and that session
// sets CLAUDE_PLUGIN_DATA. Set both variables explicitly on every case, or the
// result depends on who is running the suite.
function withPluginDataEnv(values, body) {
  const names = ["GEMINI_COMPANION_DATA", "CLAUDE_PLUGIN_DATA"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) {
      const next = values[name];
      if (next == null) delete process.env[name];
      else process.env[name] = next;
    }
    body();
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test("resolveStateDir falls back to a temp-backed directory when neither variable is set", () => {
  const workspace = makeTempDir();
  withPluginDataEnv({}, () => {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(os.tmpdir()), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  });
});

// The defect this pins: CLAUDE_PLUGIN_DATA is the variable Claude Code sets and
// session-lifecycle-hook.mjs forwards, but this module used to read only
// GEMINI_COMPANION_DATA — which nothing sets — so every real install landed in
// the temp directory and lost background job state to OS cleanup.
test("resolveStateDir honors CLAUDE_PLUGIN_DATA, which is the variable Claude Code sets", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataEnv({ CLAUDE_PLUGIN_DATA: pluginDataDir }, () => {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    // The fallback root, not os.tmpdir() itself — makeTempDir builds the plugin
    // data dir under the temp directory too.
    assert.ok(
      !stateDir.startsWith(path.join(os.tmpdir(), "gemini-companion")),
      "state must not land in the OS-cleaned fallback root"
    );
  });
});

test("resolveStateDir honors GEMINI_COMPANION_DATA when provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();

  withPluginDataEnv({ GEMINI_COMPANION_DATA: pluginDataDir }, () => {
    const stateDir = resolveStateDir(workspace);
    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  });
});

// Deprecated, but it was readable in shipped source, so anyone who set it keeps
// their location rather than being silently moved by an upgrade.
test("GEMINI_COMPANION_DATA overrides CLAUDE_PLUGIN_DATA when both are set", () => {
  const workspace = makeTempDir();
  const explicit = makeTempDir();
  const host = makeTempDir();

  withPluginDataEnv({ GEMINI_COMPANION_DATA: explicit, CLAUDE_PLUGIN_DATA: host }, () => {
    assert.equal(resolveStateDir(workspace).startsWith(path.join(explicit, "state")), true);
  });
});

test("a blank plugin-data variable falls through instead of rooting state at ''", () => {
  const workspace = makeTempDir();
  const host = makeTempDir();

  withPluginDataEnv({ GEMINI_COMPANION_DATA: "   ", CLAUDE_PLUGIN_DATA: host }, () => {
    assert.equal(resolveStateDir(workspace).startsWith(path.join(host, "state")), true);
  });
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

function seedJobOnDisk(workspace, jobId, overrides = {}) {
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
  fs.writeFileSync(
    resolveJobFile(workspace, jobId),
    JSON.stringify({ id: jobId, status: "completed", logFile, createdAt: updatedAt, updatedAt, ...overrides }, null, 2),
    "utf8"
  );
  return logFile;
}

test("a job whose record is on disk is listed even if state.json never mentioned it", () => {
  const workspace = makeTempDir();
  seedJobOnDisk(workspace, "task-orphaned");

  // The defect this pins: the listing used to come from a shared state.json
  // index that a concurrent writer could drop the entry from, and `/gemini:result`
  // then reported "No job found" for a finished job whose record and output were
  // sitting right there.
  assert.deepEqual(listJobs(workspace).map((job) => job.id), ["task-orphaned"]);
});

test("the listing withholds job output so /gemini:status stays the size it was", () => {
  const workspace = makeTempDir();
  writeJobFile(workspace, "task-big", {
    id: "task-big",
    status: "completed",
    result: { rawOutput: "x".repeat(1000) },
    rendered: "x".repeat(1000)
  });

  const [listed] = listJobs(workspace);
  assert.equal(listed.status, "completed");
  assert.equal("result" in listed, false);
  assert.equal("rendered" in listed, false);
  // The output is still reachable where /gemini:result reads it.
  assert.equal(readJobFile(resolveJobFile(workspace, "task-big")).rendered.length, 1000);
});

test("a legacy state.json job index is migrated into per-job files", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGateEnabled: true },
      jobs: [{ id: "task-legacy", status: "completed", updatedAt: "2026-01-01T00:00:00.000Z" }]
    }, null, 2)}\n`,
    "utf8"
  );

  assert.deepEqual(listJobs(workspace).map((job) => job.id), ["task-legacy"]);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-legacy")), true);

  const migrated = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(migrated.config.stopReviewGateEnabled, true, "config must survive the migration");
  assert.equal("jobs" in migrated, false, "the legacy array must be dropped once materialized");
});

test("pruning past the cap drops the oldest finished jobs and their logs", () => {
  const workspace = makeTempDir();
  for (let index = 0; index < 51; index += 1) {
    seedJobOnDisk(workspace, `job-${index}`, {
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString()
    });
  }

  pruneJobStore(workspace);

  assert.equal(listJobs(workspace).length, 50);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-50")), true);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), false);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-0")), false);
});

// The defect this pins: pruning used to diff the caller's in-memory job list
// against what was on disk, so a worker that started before a sibling's job
// existed deleted that sibling's record and log — measured at up to 4 of 6 jobs
// destroyed per run on Windows. An unfinished job is never evictable now.
test("pruning never evicts a job that is still queued or running", () => {
  const workspace = makeTempDir();
  seedJobOnDisk(workspace, "job-active", {
    status: "running",
    updatedAt: new Date(Date.UTC(2020, 0, 1)).toISOString() // oldest by far
  });
  for (let index = 0; index < 60; index += 1) {
    seedJobOnDisk(workspace, `job-${index}`, {
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString()
    });
  }

  pruneJobStore(workspace);

  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-active")), true, "a running job was deleted");
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "job-active")), true, "a running job's log was deleted");
});

test("removeJobs deletes only the records its predicate selects", () => {
  const workspace = makeTempDir();
  seedJobOnDisk(workspace, "task-mine", { sessionId: "session-a" });
  seedJobOnDisk(workspace, "task-theirs", { sessionId: "session-b" });

  const removed = removeJobs(workspace, (job) => job.sessionId === "session-a");

  assert.deepEqual(removed.map((job) => job.id), ["task-mine"]);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-mine")), false);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "task-mine")), false);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "task-theirs")), true);
  assert.equal(fs.existsSync(resolveJobLogFile(workspace, "task-theirs")), true);
});

test("generateJobId produces a prefixed id with a crypto-random suffix", () => {
  const id = generateJobId("task");
  assert.match(id, /^task-[0-9a-z]+-[0-9a-f]{10}$/);
  assert.notEqual(generateJobId("task"), generateJobId("task"));
});

test("state and job writes leave parseable JSON", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);

  saveState(workspace, { version: 1, config: { stopReviewGateEnabled: true } });
  const jobFile = writeJobFile(workspace, "task-1", { id: "task-1", status: "completed" });

  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).config.stopReviewGateEnabled, true);
  assert.equal(JSON.parse(fs.readFileSync(jobFile, "utf8")).status, "completed");
});

// The promise a background user actually depends on: start several jobs at once
// and every one of them is still there, complete, when the batch finishes.
//
// The previous shape of this test asserted only that a reader never saw a
// half-written state.json, with a comment conceding that "concurrent writers
// keep each other's jobs" was something a load/mutate/save cycle could not
// promise. It could not — so the store stopped being one shared mutable list.
// Measured against the old code this fails outright: 6 concurrent workers lost
// 1–4 job records per run to a sibling's prune, plus EPERM on the shared
// rename. Writers here do NOT retry: any sharing error must be handled inside
// state.mjs, not papered over by the test.
test("concurrent workers each keep their own job record, log and output", async () => {
  const workspace = makeTempDir();
  const stateModule = new URL("../plugins/gemini/scripts/lib/state.mjs", import.meta.url).href;
  const worker = path.join(workspace, "writer.mjs");
  const tags = ["a", "b", "c", "d", "e", "f"];

  fs.writeFileSync(
    worker,
    [
      `const { upsertJob, writeJobFile, resolveJobLogFile } = await import(${JSON.stringify(stateModule)});`,
      "const fs = await import('node:fs');",
      "const [workspace, tag] = process.argv.slice(2);",
      "const id = `task-${tag}`;",
      "const logFile = resolveJobLogFile(workspace, id);",
      "fs.writeFileSync(logFile, `[start] ${id}\\n`, 'utf8');",
      "writeJobFile(workspace, id, { id, status: 'queued', phase: 'queued', logFile });",
      "// The transitions a real worker makes, ending in the record /gemini:result reads.",
      "upsertJob(workspace, { id, status: 'running', phase: 'starting', logFile });",
      "upsertJob(workspace, { id, phase: 'running', logFile });",
      "upsertJob(workspace, { id, status: 'completed', phase: 'done', logFile, rendered: `OUTPUT-${tag}` });",
      "fs.appendFileSync(logFile, `[final] ${id}\\n`, 'utf8');"
    ].join("\n"),
    "utf8"
  );

  await Promise.all(
    tags.map(
      (tag) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [worker, workspace, tag], { stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${tag} exited ${code}: ${stderr}`))));
        })
    )
  );

  const listed = listJobs(workspace);
  assert.deepEqual(
    listed.map((job) => job.id).sort(),
    tags.map((tag) => `task-${tag}`).sort(),
    "a concurrent worker's job went missing from the listing"
  );
  for (const job of listed) {
    assert.equal(job.status, "completed", `${job.id} did not reach its final status`);
  }
  for (const tag of tags) {
    const stored = readJobFile(resolveJobFile(workspace, `task-${tag}`));
    assert.equal(stored.rendered, `OUTPUT-${tag}`, `task-${tag} lost the output it produced`);
    const log = fs.readFileSync(resolveJobLogFile(workspace, `task-${tag}`), "utf8");
    assert.match(log, /\[start\]/, `task-${tag}'s log was deleted mid-run and recreated`);
    assert.match(log, /\[final\]/);
  }

  const stateDir = path.dirname(resolveStateFile(workspace));
  const leftovers = fs
    .readdirSync(path.join(stateDir, "jobs"))
    .concat(fs.readdirSync(stateDir))
    .filter((name) => name.endsWith(".tmp"));
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

// Corrupt and deleted are different. readJobFile fails closed on every error,
// so a record removed between listJobs' readdir and its read surfaced as a
// phantom `failed` job with an `invalid-json` cause — for an id that no longer
// existed, and which then counted toward MAX_JOBS. Both deleters race this:
// pruneJobStore fires on every new job, and the SessionEnd sweep on every exit,
// while `/gemini:status --wait` polls listJobs every two seconds.
test("a job deleted mid-scan is dropped from the listing, not reported as failed", (t) => {
  const workspace = makeTempDir();
  seedJobOnDisk(workspace, "task-alive");
  seedJobOnDisk(workspace, "task-swept");

  // The window is between the readdir and the read, so the deletion has to land
  // there: deleting beforehand removes the directory entry too and the race is
  // never entered. Patching readdirSync is the only way to occupy that window
  // deterministically from a single process.
  const realReaddirSync = fs.readdirSync;
  t.after(() => {
    fs.readdirSync = realReaddirSync;
  });
  fs.readdirSync = (...args) => {
    const entries = realReaddirSync(...args);
    if (entries.includes("task-swept.json")) {
      fs.rmSync(resolveJobFile(workspace, "task-swept"));
    }
    return entries;
  };

  const jobs = listJobs(workspace);

  assert.deepEqual(jobs.map((job) => job.id), ["task-alive"]);
  assert.equal(jobs.some((job) => job.status === "failed"), false, "a deleted job was reported as failed");
});

// The fail-closed path must survive: a file that is present but unreadable is a
// job whose fate is unknown, and dropping it silently would hide a real failure.
test("an unreadable job file is still listed as failed", () => {
  const workspace = makeTempDir();
  seedJobOnDisk(workspace, "task-alive");
  fs.writeFileSync(resolveJobFile(workspace, "task-corrupt"), "{ not-json", "utf8");

  const jobs = listJobs(workspace);
  const corrupt = jobs.find((job) => job.id === "task-corrupt");

  assert.ok(corrupt, "a corrupt record must not be dropped from the listing");
  assert.equal(corrupt.status, "failed");
  assert.equal(corrupt.failure.category, "invalid-json");
});

// Eviction deletes results that were already paid for, and it used to do so in
// complete silence: writeJobFile discarded pruneJobStore's return value, so the
// 51st job removed the oldest finished result and its log with nothing in the
// output. "most recent 50 kept" in the README reads as housekeeping, not as "a
// result you have not read can disappear".
test("making room for a new job says which finished results it deleted", () => {
  const workspace = makeTempDir();
  for (let index = 0; index < 50; index += 1) {
    seedJobOnDisk(workspace, `job-${index}`, {
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString()
    });
  }

  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    writeJobFile(workspace, "job-new", {
      id: "job-new",
      status: "queued",
      updatedAt: new Date(Date.UTC(2026, 0, 2)).toISOString()
    });
  } finally {
    process.stderr.write = original;
  }

  const warning = written.find((line) => /job store is capped/.test(line));
  assert.ok(warning, `expected an eviction warning; got ${JSON.stringify(written)}`);
  assert.match(warning, /removed 1 finished job\(s\)/);
  assert.match(warning, /job-0\b/, "the warning must name what was deleted");
  assert.match(warning, /gemini:result/, "it must say what is no longer retrievable");
  // It must not claim the result was uncollected: nothing records whether
  // /gemini:result ever read a job, so that would be a guess presented as fact.
  assert.doesNotMatch(warning, /uncollected|never (read|collected)/i);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "job-0")), false);
});

test("a new job that evicts nothing stays quiet", () => {
  const workspace = makeTempDir();
  seedJobOnDisk(workspace, "job-only");

  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    writeJobFile(workspace, "job-second", { id: "job-second", status: "queued" });
  } finally {
    process.stderr.write = original;
  }

  assert.equal(
    written.filter((line) => /job store is capped/.test(line)).length,
    0,
    "under the cap there is nothing to report"
  );
});
