import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../plugins/gemini", import.meta.url)));
const SERVER = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8")).mcpServers.gemini;

// Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} in command/args/env and has no
// cwd field -- the server inherits the host's working directory. The directory's
// validator only follows a literal `${CLAUDE_PLUGIN_ROOT}/<file>` path, so the
// manifest is exactly that and nothing computed. Codex passes args through
// literally and is deliberately not supported by this manifest.
async function initialize({ cwd }) {
  const ex = (s) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);

  const child = spawn(ex(SERVER.command), SERVER.args.map(ex), {
    cwd,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"]
  });

  try {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    const firstLine = new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("MCP server did not respond to initialize within 15s")), 15000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl !== -1) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
      });
      child.once("error", (e) => { clearTimeout(timer); reject(e); });
      // Exit code 0 with no reply is the failure this test exists to catch: the
      // entry guard did not recognise the launch path and started no stdio loop.
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`MCP server exited before answering initialize (code ${code}): ${stderr.trim() || "no stderr"}`));
      });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    return JSON.parse(await firstLine);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
}

test("the manifest launches one literal script path under CLAUDE_PLUGIN_ROOT, nothing computed", () => {
  // Removing the old `node -e` bootstrap is what lets the directory validator
  // read the launch command; a computed path or inline program blocks submission.
  assert.equal(SERVER.command, "node");
  assert.deepEqual(SERVER.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/gemini-mcp.mjs"]);
  assert.equal(SERVER.cwd, undefined, "Claude Code has no cwd field; a relative cwd would not mean the plugin dir there");
  assert.equal(SERVER.env, undefined, "the plugin root is no longer handed over by env");
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, "scripts", "gemini-mcp.mjs")), "the literal path must exist in the plugin");
});

test("Claude Code's reading launches the server: placeholder expanded, cwd inherited", async () => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-launch-"));
  try {
    const reply = await initialize({ cwd: tempCwd });
    assert.equal(reply.id, 1);
    assert.equal(reply.result.serverInfo.name, "gemini");
    assert.equal(typeof reply.result.protocolVersion, "string");
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("importing the server module starts no stdio loop", async () => {
  const module = await import(new URL("../plugins/gemini/scripts/gemini-mcp.mjs", import.meta.url));
  assert.ok(module, "module must import without taking over stdin");
});

test("starting the server consumes GEMINI_MCP_STDIO instead of passing it to children", async () => {
  // The server spawns its detached worker with `env: process.env`, and the
  // worker spawns the CLI the same way. An inherited flag turns every descendant
  // that imports this module into a server that grabs stdin and never exits --
  // including a delegated turn running this repo's own suite.
  const probe = [
    "await import(process.argv[1]);",
    "console.log(JSON.stringify({ flag: process.env.GEMINI_MCP_STDIO ?? null }));",
    "process.exit(0);"
  ].join("");

  const child = spawn(
    process.execPath,
    // A file:// href, not a path: on Windows the ESM loader rejects `c:\...`.
    ["--input-type=module", "-e", probe, new URL("../plugins/gemini/scripts/gemini-mcp.mjs", import.meta.url).href],
    { env: { ...process.env, GEMINI_MCP_STDIO: "1" }, stdio: ["pipe", "pipe", "pipe"] }
  );

  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { err += chunk; });

  const [code] = await once(child, "exit");
  assert.equal(code, 0, `probe exited ${code}: ${err.trim()}`);
  const line = out.trim().split(/\r?\n/).find((l) => l.includes("flag"));
  assert.ok(line, `probe printed no result: ${out.trim() || err.trim()}`);
  assert.equal(JSON.parse(line).flag, null, "the flag must not survive into anything the server spawns");
});
