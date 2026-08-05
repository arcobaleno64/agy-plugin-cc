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

export const TOOLS = [
  tool(
    "gemini_rescue",
    "Delegate a task to Gemini or AGY",
    "Queue a Gemini/AGY rescue task through the existing companion runtime. With `write: true` the delegated CLI may edit files anywhere it can reach; it is not confined to the workspace.",
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
      engine: enumSchema(["auto", "gemini", "agy"])
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
      deep: { type: "boolean", default: false }
    }
  ),
  tool(
    "gemini_job_status",
    "Check a delegated job's status",
    "Return the current state of a Gemini companion job.",
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
    "Return the stored output of a finished Gemini companion job.",
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
    "Cancel a queued or running Gemini companion job, terminating its process tree.",
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
      engine: optionalEnum(args.engine, "engine", ["auto", "gemini", "agy"])
    });
  }
  if (name === "gemini_review") {
    return runtime.dispatchBackgroundReview({
      cwd: workspace,
      base: optionalString(args.base, "base"),
      scope: optionalEnum(args.scope, "scope", ["auto", "working-tree", "branch"]),
      model: optionalString(args.model, "model"),
      engine: optionalEnum(args.engine, "engine", ["auto", "gemini", "agy"]),
      deep: optionalBoolean(args.deep, "deep") ?? false,
      reviewName: "Review",
      templateName: "review"
    });
  }

  const jobId = requiredString(args.jobId, "jobId");
  if (name === "gemini_job_status") return runtime.getJobStatus({ cwd: workspace, jobId });
  if (name === "gemini_job_result") return runtime.getJobResult({ cwd: workspace, jobId });
  if (name === "gemini_job_cancel") {
    const cancelled = await runtime.cancelJob({ cwd: workspace, jobId });
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

if (process.argv[1] === SELF_PATH) {
  main();
}
