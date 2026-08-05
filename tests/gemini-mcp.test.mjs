import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { handleRequest } from "../plugins/gemini/scripts/gemini-mcp.mjs";
import { dispatchBackgroundTask } from "../plugins/gemini/scripts/gemini-companion.mjs";
import { readStoredJob } from "../plugins/gemini/scripts/lib/job-control.mjs";
import { initGitRepo, makeTempDir } from "./helpers.mjs";

function toolRequest(name, args) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

test("gemini MCP advertises its identity and five tools", async () => {
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
    "gemini_job_status",
    "gemini_job_result",
    "gemini_job_cancel"
  ]);
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

  // The review path runs with write disabled but still sends the diff out.
  assert.equal(byName.gemini_review.readOnlyHint, true);
  assert.equal(byName.gemini_review.openWorldHint, true);

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
      engine: "gemini"
    }],
    ["review", {
      cwd: path.resolve(workspace),
      base: undefined,
      scope: "working-tree",
      model: undefined,
      engine: "agy",
      deep: true,
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
