import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { handleRequest, TOOLS } from "../plugins/gemini/scripts/gemini-mcp.mjs";
import { dispatchBackgroundTask } from "../plugins/gemini/scripts/gemini-companion.mjs";
import { readStoredJob } from "../plugins/gemini/scripts/lib/job-control.mjs";
import { writeJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

function toolRequest(name, args) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

test("gemini MCP advertises its identity and six tools", async () => {
  const initialized = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const pluginVersion = JSON.parse(
    fs.readFileSync(new URL("../plugins/gemini/.claude-plugin/plugin.json", import.meta.url), "utf8")
  ).version;
  assert.equal(initialized.serverInfo.name, "gemini");
  assert.equal(initialized.serverInfo.version, pluginVersion);

  const listed = await handleRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "gemini_rescue",
    "gemini_review",
    "gemini_adversarial_review",
    "gemini_job_status",
    "gemini_job_result",
    "gemini_job_cancel"
  ]);
});

// `serverInfo.version` was already correct and already useless: no host shows it,
// so field note gi-2026-08-17-a1c7 had to identify a stale 0.17.3 server by reading
// its process command line. `instructions` is the part of the initialize result
// hosts inject into the agent's context, so what is pinned here is that the running
// version and script path are stated *there* -- asserting only that the string is
// non-empty would pass on boilerplate that names no version at all.
test("the MCP surface states which copy of the plugin is answering", async () => {
  const initialized = await handleRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const pluginVersion = JSON.parse(
    fs.readFileSync(new URL("../plugins/gemini/.claude-plugin/plugin.json", import.meta.url), "utf8")
  ).version;

  assert.equal(typeof initialized.instructions, "string");
  assert.ok(
    initialized.instructions.includes(pluginVersion),
    `instructions must name the running version (${pluginVersion}), got: ${initialized.instructions}`
  );
  // Two surfaces disagreeing is the whole failure, so the version alone is not
  // enough -- the path is what says *which copy* this is when two are installed.
  assert.ok(
    initialized.instructions.includes(path.join("scripts", "gemini-mcp.mjs")),
    `instructions must name the running script, got: ${initialized.instructions}`
  );
  // The first draft of these instructions told the reader to run
  // `gemini-companion setup`, which is not a command -- this package publishes no
  // `bin`. An agent following that verbatim gets command-not-found and is back to
  // having no comparison version, which is the exact state gi-2026-08-17-a1c7
  // describes. So the promise pinned here is that the diagnostic the instructions
  // name is real and runnable, not merely that some path was interpolated.
  const quoted = initialized.instructions.match(/node "([^"]+)" setup --json/);
  assert.ok(quoted, `instructions must name a runnable setup command, got: ${initialized.instructions}`);
  assert.ok(fs.existsSync(quoted[1]), `the setup script the instructions name must exist: ${quoted[1]}`);
});

// Adversarial review has been on the slash surface since it shipped and is listed
// in both READMEs under Features, but MCP exposed no way to reach it and said
// nothing about why — so an agent driving the plugin through MCP had the feature
// missing rather than declined.
test("MCP can run an adversarial review, not only the standard one", async () => {
  const workspace = makeTempDir();
  const calls = [];
  const runtime = {
    dispatchBackgroundReview(input) {
      calls.push(input);
      return { jobId: "review-adv-1", status: "queued" };
    }
  };

  const queued = await handleRequest(toolRequest("gemini_adversarial_review", {
    workspace,
    engine: "agy",
    focus: "the migration path"
  }), { runtime });

  assert.equal(queued.structuredContent.jobId, "review-adv-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].templateName, "adversarial-review", "the adversarial template is the whole point of the tool");
  assert.equal(calls[0].reviewName, "Adversarial Review");
  assert.equal(calls[0].focusText, "the migration path");
});

// The standard review takes no focus argument on the slash surface either, and a
// silently ignored argument is worse than an absent one.
test("gemini_review still queues the standard template and takes no focus", async () => {
  const workspace = makeTempDir();
  const calls = [];
  const runtime = {
    dispatchBackgroundReview(input) {
      calls.push(input);
      return { jobId: "review-std-1", status: "queued" };
    }
  };

  await handleRequest(toolRequest("gemini_review", { workspace }), { runtime });
  assert.equal(calls[0].templateName, "review");
  assert.equal(calls[0].reviewName, "Review");
  assert.ok(!("focusText" in calls[0]));

  const rejected = await handleRequest(toolRequest("gemini_review", { workspace, focus: "x" }), { runtime });
  assert.equal(rejected.isError, true, "an argument the tool does not accept must be refused, not dropped");
});

// Neither README documented the MCP surface at all, which is the structural
// reason adversarial review could be missing from it for as long as it was: there
// was no list for a missing tool to be missing from. Both directions are asserted,
// so adding a tool without documenting it fails, and documenting a tool that does
// not exist fails too — the second is how a rename would otherwise leave a README
// promising a tool no client can call.
function parseReadmeToolNames(readme, heading) {
  const afterHeading = readme.split(new RegExp(`^##\\s+${heading}\\s*$`, "m"))[1];
  assert.ok(afterHeading, `README must have a \`## ${heading}\` section`);
  const body = afterHeading.split(/^---\s*$/m)[0];
  const names = new Set();
  for (const line of body.split(/\r?\n/)) {
    if (!/^\|\s*`gemini_/.test(line)) continue;
    const first = line.split("|").map((cell) => cell.trim()).filter(Boolean)[0];
    for (const match of first.matchAll(/`(gemini_[a-z_]+)`/g)) names.add(match[1]);
  }
  return names;
}

function parseReadmeToolRows(readme, heading) {
  const afterHeading = readme.split(new RegExp(`^##\\s+${heading}\\s*$`, "m"))[1];
  assert.ok(afterHeading, `README must have a \`## ${heading}\` section`);
  const body = afterHeading.split(/^---\s*$/m)[0];
  const rows = new Map();
  const backticked = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

  for (const line of body.split(/\r?\n/)) {
    if (!/^\|\s*`gemini_/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const [name] = backticked(cells[0]);
    rows.set(name, {
      required: backticked(cells[1]),
      optional: backticked(cells[2]),
      readOnly: /^(yes|是)$/i.test(cells[3])
    });
  }
  return rows;
}

test("both READMEs list exactly the MCP tools the server serves", () => {
  const served = new Set(TOOLS.map((tool) => tool.name));
  for (const [file, heading] of [["README.md", "MCP Tools"], ["README.zh-TW.md", "MCP 工具"]]) {
    const readme = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const documented = parseReadmeToolNames(readme, heading);
    for (const name of served) {
      assert.ok(documented.has(name), `${file} does not document \`${name}\``);
    }
    for (const name of documented) {
      assert.ok(served.has(name), `${file} documents \`${name}\`, which the server does not serve`);
    }
  }
});

test("both README MCP tables match the served schemas and read-only annotations", () => {
  for (const [file, heading] of [["README.md", "MCP Tools"], ["README.zh-TW.md", "MCP 工具"]]) {
    const readme = fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const rows = parseReadmeToolRows(readme, heading);

    for (const tool of TOOLS) {
      const row = rows.get(tool.name);
      assert.ok(row, `${file} has no table row for ${tool.name}`);
      const required = [...tool.inputSchema.required].sort();
      const optional = Object.keys(tool.inputSchema.properties).filter((name) => !required.includes(name)).sort();
      assert.deepEqual(row.required.sort(), required, `${file} required inputs drifted for ${tool.name}`);
      assert.deepEqual(row.optional.sort(), optional, `${file} optional inputs drifted for ${tool.name}`);
      assert.equal(row.readOnly, tool.annotations.readOnlyHint, `${file} read-only claim drifted for ${tool.name}`);
    }
  }
});

// The Anthropic software directory policy requires every applicable annotation,
// naming readOnlyHint, destructiveHint and title. A client uses them to decide
// whether a call needs confirmation, so a missing or flattering hint is a real
// disclosure defect, not metadata tidiness.
test("every MCP tool carries the annotations a client needs to gate it", async () => {
  const { tools } = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

  for (const tool of tools) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} has no annotations`);
    assert.equal(typeof a.title, "string", `${tool.name} has no title`);
    assert.ok(a.title.length > 0 && a.title !== tool.name, `${tool.name} title must be human-readable`);
    assert.equal(typeof a.readOnlyHint, "boolean", `${tool.name} has no readOnlyHint`);
    assert.equal(typeof a.openWorldHint, "boolean", `${tool.name} has no openWorldHint`);

    // destructiveHint and idempotentHint only carry meaning when a tool can
    // write, and asserting them on a read-only tool would invite a meaningless
    // `destructiveHint: false` on everything.
    if (a.readOnlyHint) {
      assert.ok(!("destructiveHint" in a), `${tool.name} is read-only; destructiveHint is meaningless`);
    } else {
      assert.equal(typeof a.destructiveHint, "boolean", `${tool.name} can write but has no destructiveHint`);
      assert.equal(typeof a.idempotentHint, "boolean", `${tool.name} can write but has no idempotentHint`);
    }

    // Policy caps tool names at 64 characters.
    assert.ok(tool.name.length <= 64, `${tool.name} exceeds the 64-character limit`);
  }
});

// Pinned individually, because these are the claims a reviewer checks against
// behavior. Getting one wrong is worse than omitting it.
test("MCP annotations match what each tool can actually do", async () => {
  const { tools } = await handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));

  // `write: true` hands the delegated agent the filesystem with no path
  // boundary, and annotations cannot vary per call, so the worst case governs.
  assert.equal(byName.gemini_rescue.readOnlyHint, false);
  assert.equal(byName.gemini_rescue.destructiveHint, true);
  assert.equal(byName.gemini_rescue.openWorldHint, true);

  // Not read-only, and this test used to say it was. What the review path
  // disables is `--write`, and on AGY whether that stops anything is decided by
  // the user's settings.json rather than by the argv. Measured on 1.1.20, both
  // arms, with exactly the argv this path builds: under `toolPermission:
  // "always-proceed"` a review turn wrote inside the workspace, wrote outside it,
  // and ran a shell command; under a minimal settings.json in an isolated home
  // all three were auto-denied. Both arms returned exit 0 and `status:
  // "SUCCESS"`.
  //
  // An annotation is static per tool and cannot read the user's settings, so the
  // worst case governs -- the same rule gemini_rescue is pinned by two assertions
  // up. The worst case is the permissive configuration, which is an ordinary
  // convenience setting.
  for (const name of ["gemini_review", "gemini_adversarial_review"]) {
    assert.equal(byName[name].readOnlyHint, false, `${name} cannot promise the workspace is untouched on AGY`);
    assert.equal(byName[name].destructiveHint, true, `${name} can write, so it needs a destructiveHint`);
    assert.equal(byName[name].openWorldHint, true, `${name} sends the diff to Google`);
  }

  // Reading job state touches neither the workspace nor the network.
  for (const name of ["gemini_job_status", "gemini_job_result"]) {
    assert.equal(byName[name].readOnlyHint, true, `${name} must be read-only`);
    assert.equal(byName[name].openWorldHint, false, `${name} must not reach the network`);
  }

  // Cancelling a write-capable task can leave half-applied edits behind.
  assert.equal(byName.gemini_job_cancel.readOnlyHint, false);
  assert.equal(byName.gemini_job_cancel.destructiveHint, true);
  assert.equal(byName.gemini_job_cancel.idempotentHint, true);
});

test("handleRequest delegates rescue and review to injected runtime dispatchers", async () => {
  const workspace = makeTempDir();
  const calls = [];
  const runtime = {
    dispatchBackgroundTask(input) {
      calls.push(["task", input]);
      return { jobId: "task-1", status: "queued" };
    },
    dispatchBackgroundReview(input) {
      calls.push(["review", input]);
      return { jobId: "review-1", status: "queued" };
    }
  };

  const rescue = await handleRequest(toolRequest("gemini_rescue", {
    workspace,
    prompt: "investigate the timeout",
    engine: "gemini",
    effort: "high"
  }), { runtime });
  assert.equal(rescue.structuredContent.jobId, "task-1");

  const review = await handleRequest(toolRequest("gemini_review", {
    workspace,
    scope: "working-tree",
    engine: "agy",
    deep: true
  }), { runtime });
  assert.equal(review.structuredContent.jobId, "review-1");
  assert.deepEqual(calls, [
    ["task", {
      cwd: path.resolve(workspace),
      prompt: "investigate the timeout",
      write: false,
      model: undefined,
      effort: "high",
      engine: "gemini",
      timeoutSeconds: null
    }],
    ["review", {
      cwd: path.resolve(workspace),
      base: undefined,
      scope: "working-tree",
      model: undefined,
      engine: "agy",
      deep: true,
      timeoutSeconds: null,
      reviewName: "Review",
      templateName: "review"
    }]
  ]);
});

test("handleRequest delegates job status, result, and cancel without reading state itself", async () => {
  const workspace = makeTempDir();
  const calls = [];
  const runtime = {
    getJobStatus(input) {
      calls.push(["status", input]);
      return { job: { id: input.jobId, status: "running" } };
    },
    getJobResult(input) {
      calls.push(["result", input]);
      return { job: { id: input.jobId, status: "completed" }, storedJob: { result: "done" } };
    },
    cancelJob(input) {
      calls.push(["cancel", input]);
      return { payload: { jobId: input.jobId, status: "cancelled" } };
    }
  };

  for (const [name, expectedStatus] of [
    ["gemini_job_status", "running"],
    ["gemini_job_result", "completed"],
    ["gemini_job_cancel", "cancelled"]
  ]) {
    const response = await handleRequest(toolRequest(name, { workspace, jobId: "job-1" }), { runtime });
    assert.equal(response.isError, undefined);
    assert.equal(response.structuredContent.job?.status ?? response.structuredContent.status, expectedStatus);
  }
  assert.deepEqual(calls.map(([kind]) => kind), ["status", "result", "cancel"]);
  assert.ok(calls.every(([, input]) => input.cwd === path.resolve(workspace) && input.jobId === "job-1"));
});

// The defect this pins: the MCP server is launched from .mcp.json and never
// receives GEMINI_COMPANION_SESSION_ID, so the session filter admitted only jobs
// carrying no session id — the ones this server queued itself. Every job queued
// by the CLI or a slash command was therefore reachable through
// gemini_job_status but reported `No job found` from gemini_job_result and
// gemini_job_cancel. Always, not intermittently.
test("the MCP job tools reach a job the CLI tagged with a Claude session id", async (t) => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir();
  initGitRepo(workspace);

  // A live worker pid, so the active job is not reconciled to `failed` as stale
  // before gemini_job_cancel gets to it — that reconcile is correct behaviour
  // and would hide whether cancel can resolve the job at all.
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();
  t.after(() => {
    try {
      process.kill(sleeper.pid);
    } catch {
      // already gone
    }
  });

  const previous = {
    data: process.env.GEMINI_COMPANION_DATA,
    session: process.env.GEMINI_COMPANION_SESSION_ID
  };
  process.env.GEMINI_COMPANION_DATA = dataDir;
  delete process.env.GEMINI_COMPANION_SESSION_ID;

  // Fresh, not a fixed date: an active job older than the 6-hour stale
  // threshold is reconciled to `failed` before cancel sees it, which would make
  // this test rot into a false pass the day after it was written.
  const now = new Date().toISOString();
  const base = {
    jobClass: "task",
    kind: "task",
    title: "Gemini Task",
    workspaceRoot: workspace,
    sessionId: "session-from-another-process",
    createdAt: now,
    updatedAt: now
  };

  try {
    writeJobFile(workspace, "task-finished", {
      ...base,
      id: "task-finished",
      status: "completed",
      phase: "done",
      result: { rawOutput: "the output the user paid for" },
      rendered: "the output the user paid for"
    });
    writeJobFile(workspace, "task-active", {
      ...base,
      id: "task-active",
      status: "running",
      phase: "running",
      startedAt: now,
      pid: sleeper.pid
    });

    const status = await handleRequest(toolRequest("gemini_job_status", { workspace, jobId: "task-finished" }));
    assert.equal(status.isError, undefined, status.content?.[0]?.text);
    assert.equal(status.structuredContent.job.id, "task-finished");

    const result = await handleRequest(toolRequest("gemini_job_result", { workspace, jobId: "task-finished" }));
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(result.structuredContent.storedJob.rendered, "the output the user paid for");

    const cancelled = await handleRequest(toolRequest("gemini_job_cancel", { workspace, jobId: "task-active" }));
    assert.equal(cancelled.isError, undefined, cancelled.content?.[0]?.text);
    assert.equal(cancelled.structuredContent.status, "cancelled");
  } finally {
    if (previous.data === undefined) delete process.env.GEMINI_COMPANION_DATA;
    else process.env.GEMINI_COMPANION_DATA = previous.data;
    if (previous.session !== undefined) process.env.GEMINI_COMPANION_SESSION_ID = previous.session;
    // The temp directories are left for the OS, as the rest of this suite does.
    // The sleeper still holds `workspace` as its cwd until t.after kills it, and
    // Windows refuses to remove a directory a live process is sitting in.
  }
});

test("handleRequest returns MCP tool errors for invalid arguments", async () => {
  const response = await handleRequest(toolRequest("gemini_rescue", {
    workspace: "relative/path",
    prompt: "inspect"
  }), { runtime: {} });
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /absolute path/i);
});

test("CLI runtime and MCP rescue dispatch persist byte-identical job prompts", async () => {
  const workspace = makeTempDir();
  const dataDir = makeTempDir();
  initGitRepo(workspace);
  const previousData = process.env.GEMINI_COMPANION_DATA;
  process.env.GEMINI_COMPANION_DATA = dataDir;
  const spawnFn = () => ({ pid: 12345, unref() {} });
  const detectEngineFn = () => ({ engine: "gemini", version: "0.45.0" });
  const prompt = "Inspect src/auth.js exactly; do not edit.\nPreserve this second line.";

  try {
    const cliDispatch = dispatchBackgroundTask({
      cwd: workspace,
      prompt,
      engine: "gemini",
      model: "flash",
      effort: "high"
    }, { spawnFn, detectEngineFn });
    const mcpDispatch = await handleRequest(toolRequest("gemini_rescue", {
      workspace,
      prompt,
      engine: "gemini",
      model: "flash",
      effort: "high"
    }), {
      runtime: {
        dispatchBackgroundTask(input) {
          return dispatchBackgroundTask(input, { spawnFn, detectEngineFn });
        }
      }
    });

    const cliJob = readStoredJob(workspace, cliDispatch.jobId);
    const mcpJob = readStoredJob(workspace, mcpDispatch.structuredContent.jobId);
    assert.equal(cliJob.request.prompt, prompt);
    assert.equal(mcpJob.request.prompt, cliJob.request.prompt);
  } finally {
    if (previousData === undefined) delete process.env.GEMINI_COMPANION_DATA;
    else process.env.GEMINI_COMPANION_DATA = previousData;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// `--timeout` has existed on the CLI since it was added, and reached neither
// surface a user actually drives: not the slash whitelists, not these schemas.
// Both 2026-08-17 timeout incidents were the 120s AGY default doing its job with
// nobody able to change it. These pin the flag as reachable *and* bounded — an
// out-of-range value must not become a spawnSync timeout the caller never meant.
// ---------------------------------------------------------------------------

import {
  MAX_TURN_TIMEOUT_SECONDS,
  MIN_TURN_TIMEOUT_SECONDS
} from "../plugins/gemini/scripts/lib/gemini.mjs";

function capturingRuntime(calls) {
  return {
    dispatchBackgroundTask(input) {
      calls.push(input);
      return { jobId: "task-1", status: "queued" };
    },
    dispatchBackgroundReview(input) {
      calls.push(input);
      return { jobId: "review-1", status: "queued" };
    }
  };
}

test("every tool that spends a turn accepts a timeout, and declares the runtime's own bounds", () => {
  const spending = TOOLS.filter((tool) => tool.annotations.openWorldHint);
  assert.equal(spending.length, 3, "rescue plus the two reviews");

  for (const tool of spending) {
    const schema = tool.inputSchema.properties.timeout;
    assert.ok(schema, `${tool.name} has no timeout argument`);
    assert.equal(schema.type, "integer");
    assert.equal(schema.minimum, MIN_TURN_TIMEOUT_SECONDS);
    assert.equal(schema.maximum, MAX_TURN_TIMEOUT_SECONDS);
  }
});

test("a timeout given to any of the three reaches the dispatcher", async () => {
  const workspace = makeTempDir();
  const calls = [];
  const runtime = capturingRuntime(calls);

  await handleRequest(toolRequest("gemini_rescue", { workspace, prompt: "p", timeout: 900 }), { runtime });
  await handleRequest(toolRequest("gemini_review", { workspace, timeout: 600 }), { runtime });
  await handleRequest(toolRequest("gemini_adversarial_review", { workspace, timeout: 300 }), { runtime });

  assert.deepEqual(calls.map((call) => call.timeoutSeconds), [900, 600, 300]);
});

test("an out-of-range or non-integer timeout is refused rather than passed on", async () => {
  const workspace = makeTempDir();
  const calls = [];
  const runtime = capturingRuntime(calls);

  for (const bad of [MIN_TURN_TIMEOUT_SECONDS - 1, MAX_TURN_TIMEOUT_SECONDS + 1, 45.5, "soon"]) {
    const response = await handleRequest(
      toolRequest("gemini_rescue", { workspace, prompt: "p", timeout: bad }),
      { runtime }
    );
    assert.equal(response.isError, true, `timeout ${bad} was not refused`);
  }
  assert.deepEqual(calls, [], "nothing reached the dispatcher");
});
