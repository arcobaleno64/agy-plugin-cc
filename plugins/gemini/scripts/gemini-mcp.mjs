#!/usr/bin/env node

import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  cancelJob,
  dispatchBackgroundReview,
  dispatchBackgroundTask,
  getJobResult,
  getJobStatus
} from "./gemini-companion.mjs";
import {
  MAX_TURN_TIMEOUT_SECONDS,
  MIN_TURN_TIMEOUT_SECONDS,
  normalizeTurnTimeoutSeconds
} from "./lib/gemini.mjs";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const SELF_PATH = fileURLToPath(import.meta.url);
const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")
);

// Annotations are hints a client uses to decide whether a call needs
// confirmation, so they describe the *worst* a call can do — they are static per
// tool and cannot vary with arguments. `gemini_rescue` therefore reports as
// destructive even though its `write` argument defaults to false.
//
// `readOnlyHint` here means "does not modify the workspace it was pointed at".
// Every tool writes plugin job state (`state.json`, `jobs/*.json`, `jobs/*.log`),
// which lives outside that workspace in Claude Code's plugin data directory and
// is bookkeeping, not user content. `openWorldHint` marks the tools that reach
// Google through the Gemini/AGY CLI.
function tool(name, title, description, annotations, required, properties) {
  return {
    name,
    description,
    annotations: { title, ...annotations },
    inputSchema: { type: "object", additionalProperties: false, required, properties }
  };
}

function enumSchema(values, defaultValue) {
  return { type: "string", enum: values, ...(defaultValue ? { default: defaultValue } : {}) };
}

// The AGY default is 2 minutes, and it is this plugin's number rather than AGY's
// own (AGY defaults --print-timeout to 5m). It doubles as a ceiling on output
// size: a turn that produces more than it can emit inside the window is killed,
// which is what both 2026-08-17 timeout incidents actually hit. The CLI has
// accepted `--timeout` since it was added; only the two surfaces a user reaches
// it through did not offer it. Bounds come from the runtime constants so the
// declared range and the enforced one cannot drift apart.
const timeoutSchema = () => ({
  type: "integer",
  minimum: MIN_TURN_TIMEOUT_SECONDS,
  maximum: MAX_TURN_TIMEOUT_SECONDS,
  description: `Seconds this turn may run before it is killed (default 120 on AGY, 600 on Gemini CLI). Also a ceiling on how much output can be produced: raise it for large batches or deep reviews. ${MIN_TURN_TIMEOUT_SECONDS}-${MAX_TURN_TIMEOUT_SECONDS}.`
});

export const TOOLS = [
  tool(
    "gemini_rescue",
    "Delegate a task to Gemini or AGY",
    "Queue a Gemini/AGY rescue task through the existing companion runtime. With `write: true` the delegated CLI may edit files anywhere it can reach; it is not confined to the workspace. `write: false` is an intent, not a sandbox: AGY has no read-only mode, so a delegated turn can still edit files, and the run reports afterwards what it wrote. `workspace` may be any existing directory, so pass one the user meant.",
    // Not read-only, because `write: true` hands the delegated agent the
    // filesystem with no path boundary (docs/THREAT-MODEL.md 7.2). Not
    // idempotent: every call queues a new job.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    ["workspace", "prompt"],
    {
      workspace: { type: "string", description: "Absolute path to the target workspace." },
      prompt: { type: "string", minLength: 1 },
      write: { type: "boolean", default: false },
      model: { type: "string" },
      effort: enumSchema(["none", "minimal", "low", "medium", "high", "xhigh"]),
      engine: enumSchema(["auto", "gemini", "agy"]),
      timeout: timeoutSchema()
    }
  ),
  tool(
    "gemini_review",
    "Review the current diff with Gemini or AGY",
    "Queue a read-only code review through the existing companion runtime. Sends the workspace diff to the configured Gemini/AGY engine; secret-looking files are withheld by filename.",
    // The review path runs the engine with write disabled, so the reviewed
    // workspace is never modified. It does send the diff to Google, which is
    // what openWorldHint is for.
    { readOnlyHint: true, openWorldHint: true },
    ["workspace"],
    {
      workspace: { type: "string", description: "Absolute path to the target workspace." },
      base: { type: "string" },
      scope: enumSchema(["auto", "working-tree", "branch"], "auto"),
      model: { type: "string" },
      engine: enumSchema(["auto", "gemini", "agy"]),
      deep: { type: "boolean", default: false },
      timeout: timeoutSchema()
    }
  ),
  // The slash surface has had /gemini:adversarial-review since it shipped, and
  // both READMEs list it under Features — but it was reachable only by a human
  // typing the command. An agent driving this plugin through MCP saw five tools,
  // none of which could select the adversarial template and none of which said
  // why, so the feature was absent rather than declined.
  //
  // A separate tool rather than a flag on gemini_review: the two differ in the
  // prompt template they run and in what their output is for, and an agent
  // choosing between tools by description picks better than one guessing at a
  // boolean.
  tool(
    "gemini_adversarial_review",
    "Adversarially review the current diff with Gemini or AGY",
    "Queue a read-only adversarial code review through the existing companion runtime. Same transport as gemini_review, but runs the adversarial template: it argues against the change rather than summarizing it, and is the one to reach for on destructive or hard-to-reverse edits. Secret-looking files are withheld by filename.",
    { readOnlyHint: true, openWorldHint: true },
    ["workspace"],
    {
      workspace: { type: "string", description: "Absolute path to the target workspace." },
      base: { type: "string" },
      scope: enumSchema(["auto", "working-tree", "branch"], "auto"),
      model: { type: "string" },
      engine: enumSchema(["auto", "gemini", "agy"]),
      deep: { type: "boolean", default: false },
      focus: { type: "string", description: "What the review should concentrate on." },
      timeout: timeoutSchema()
    }
  ),
  tool(
    "gemini_job_status",
    "Check a delegated job's status",
    "Return the current state of a Gemini companion job. Terminal status is `completed`, `failed`, `cancelled`, or `partial` — `partial` means the engine was cut off after producing text, so output exists and is worth reading, but nothing confirmed it is the whole answer. Do not treat `partial` as failure: re-running it is billed from the start.",
    { readOnlyHint: true, openWorldHint: false },
    ["workspace", "jobId"],
    {
      workspace: { type: "string", description: "Absolute path to the job workspace." },
      jobId: { type: "string", minLength: 1 }
    }
  ),
  tool(
    "gemini_job_result",
    "Read a finished job's output",
    "Return the stored output of a finished Gemini companion job, including one whose status is `partial` (cut off after producing text — read it before deciding to re-run).",
    { readOnlyHint: true, openWorldHint: false },
    ["workspace", "jobId"],
    {
      workspace: { type: "string", description: "Absolute path to the job workspace." },
      jobId: { type: "string", minLength: 1 }
    }
  ),
  tool(
    "gemini_job_cancel",
    "Cancel a delegated job",
    "Cancel a queued or running Gemini companion job, terminating its process tree. `jobId` also accepts an adversarial-review group id, which cancels every member of that group still active and leaves finished members alone.",
    // Destructive because a cancelled `write` task can leave half-applied edits
    // behind. Idempotent: cancelling an already-finished job is a no-op.
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    ["workspace", "jobId"],
    {
      workspace: { type: "string", description: "Absolute path to the job workspace." },
      jobId: { type: "string", minLength: 1 }
    }
  )
];

const DEFAULT_RUNTIME = {
  cancelJob,
  dispatchBackgroundReview,
  dispatchBackgroundTask,
  getJobResult,
  getJobStatus
};

function workspacePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error("workspace must be an absolute path.");
  }
  const resolved = path.resolve(value);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error();
  } catch {
    throw new Error("workspace must identify an existing directory.");
  }
  return resolved;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
}

function optionalString(value, name) {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value;
}

function optionalBoolean(value, name) {
  if (value == null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalEnum(value, name, values) {
  if (value == null) return undefined;
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}.`);
  }
  return value;
}

export async function callTool(name, args = {}, { runtime = DEFAULT_RUNTIME } = {}) {
  const workspace = workspacePath(args.workspace);

  if (name === "gemini_rescue") {
    return runtime.dispatchBackgroundTask({
      cwd: workspace,
      prompt: requiredString(args.prompt, "prompt"),
      write: optionalBoolean(args.write, "write") ?? false,
      model: optionalString(args.model, "model"),
      effort: optionalEnum(args.effort, "effort", ["none", "minimal", "low", "medium", "high", "xhigh"]),
      engine: optionalEnum(args.engine, "engine", ["auto", "gemini", "agy"]),
      timeoutSeconds: normalizeTurnTimeoutSeconds(args.timeout, "timeout")
    });
  }
  if (name === "gemini_review" || name === "gemini_adversarial_review") {
    const adversarial = name === "gemini_adversarial_review";
    // The two tools differ by one argument, which is exactly the shape a caller
    // gets wrong. Nothing else here validates unknown keys — the schemas declare
    // additionalProperties: false and clients are expected to enforce it — but a
    // focus dropped in silence means the review the caller asked for is not the
    // review that runs, so this one is checked rather than assumed.
    if (!adversarial && args.focus != null) {
      throw new Error("gemini_review takes no focus. Use gemini_adversarial_review for a focused review, matching /gemini:review and /gemini:adversarial-review.");
    }
    return runtime.dispatchBackgroundReview({
      cwd: workspace,
      base: optionalString(args.base, "base"),
      scope: optionalEnum(args.scope, "scope", ["auto", "working-tree", "branch"]),
      model: optionalString(args.model, "model"),
      engine: optionalEnum(args.engine, "engine", ["auto", "gemini", "agy"]),
      deep: optionalBoolean(args.deep, "deep") ?? false,
      // Validated here, not left to the schema: a client is expected to enforce
      // the declared bounds but nothing makes it, and an out-of-range value
      // reaches spawnSync as a timeout the caller never meant.
      timeoutSeconds: normalizeTurnTimeoutSeconds(args.timeout, "timeout"),
      // Focus text is accepted only by the adversarial tool, matching the slash
      // commands: /gemini:review takes no focus argument either.
      ...(adversarial ? { focusText: optionalString(args.focus, "focus") ?? "" } : {}),
      reviewName: adversarial ? "Adversarial Review" : "Review",
      templateName: adversarial ? "adversarial-review" : "review"
    });
  }

  // Every job tool here is addressed by an explicit job id, so all three cross
  // sessions — matching gemini_job_status, which never filtered by session at
  // all. The session filter exists to keep the *discovery* paths honest (the
  // bare `/gemini:status` listing, `--resume-last`, cancel's "the one active
  // job" shortcut); it cannot serve that purpose for a caller who already holds
  // the id, and here it actively broke them.
  //
  // This MCP server is launched from .mcp.json and so never receives
  // GEMINI_COMPANION_SESSION_ID — session-lifecycle-hook.mjs can only export it
  // into CLAUDE_ENV_FILE, which reaches later Bash commands, not a server
  // started alongside them. With no session id the filter admits only jobs that
  // carry none, i.e. the ones this server queued itself. So every job queued by
  // the CLI or a slash command reported `No job found` from gemini_job_result
  // and gemini_job_cancel while gemini_job_status returned it fine — not
  // intermittently, always.
  //
  // `all: true` is the answer to that and stays. It is not a workaround for the
  // other half of the same missing session id — jobs queued HERE being untagged,
  // and so unreachable from the slash commands. That half is fixed where it
  // belongs, in filterJobsForCurrentSession: an untagged job is now shown by the
  // discovery paths, because "nobody could say whose it is" was never the same
  // claim as "it is someone else's". Removing `all: true` would still break these
  // three tools, because a job queued by a slash command is tagged, and this
  // process has no id to match it against.
  const jobId = requiredString(args.jobId, "jobId");
  if (name === "gemini_job_status") return runtime.getJobStatus({ cwd: workspace, jobId });
  if (name === "gemini_job_result") return runtime.getJobResult({ cwd: workspace, jobId, all: true });
  if (name === "gemini_job_cancel") {
    const cancelled = await runtime.cancelJob({ cwd: workspace, jobId, all: true });
    return cancelled.payload ?? cancelled;
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleRequest(request, dependencies = {}) {
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "ping") return {};
  if (request.method === "initialize") {
    return {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "gemini", version: SERVER_VERSION }
    };
  }
  if (request.method === "tools/list") return { tools: TOOLS };
  if (request.method === "tools/call") {
    try {
      const result = await callTool(request.params?.name, request.params?.arguments, dependencies);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  }
  throw new Error(`Unsupported method: ${request.method}`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function main() {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
      const result = await handleRequest(request);
      if (request.id !== undefined && result !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
      if (request === undefined) send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      else if (request.id !== undefined) {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }
}

// Started as the process entry point (`node scripts/gemini-mcp.mjs`), or by the
// `.mcp.json` bootstrap, which sets GEMINI_MCP_STDIO in its own process before
// importing this module. The bootstrap exists because Codex passes MCP `args`
// through literally -- it never expands ${CLAUDE_PLUGIN_ROOT} -- so the script
// path has to be computed at runtime, and under `node -e` there is no argv[1]
// to match against at all.
if (process.argv[1] === SELF_PATH || process.env.GEMINI_MCP_STDIO === "1") {
  // Consume the signal instead of propagating it. This process hands
  // `process.env` to the detached worker it spawns, which hands it to the CLI,
  // so an inherited flag would make every descendant that merely *imports* this
  // module take over stdin and never exit -- a delegated turn running this
  // repo's own suite hangs on the files that import it. Deleting it here is what
  // keeps "importing this module starts nothing" true below the server too.
  delete process.env.GEMINI_MCP_STDIO;
  main();
}
