import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../plugins/gemini", import.meta.url)));

// Regression guard for the .mcp.json launch path: the script argument MUST
// resolve relative to the plugin root (${CLAUDE_PLUGIN_ROOT}), while the server
// MUST NOT declare cwd using that placeholder. Codex expands the script argument
// but may pass cwd through literally on Windows, where process creation then
// fails with ERROR_DIRECTORY (267). Launch from a temp cwd that is deliberately
// not the plugin dir and require the server to answer initialize.
test("the .mcp.json server command launches from a cwd that is not the plugin dir", async () => {
  const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".mcp.json"), "utf8"));
  const server = config.mcpServers.gemini;

  const expand = (s) => s.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
  const command = expand(server.command);
  const args = server.args.map(expand);
  assert.equal(server.cwd, undefined, ".mcp.json must inherit the host cwd instead of declaring ${CLAUDE_PLUGIN_ROOT} as cwd");

  // Sanity: the resolved script path must be absolute and exist, so a
  // relative-path regression (./scripts/...) is caught before spawning.
  const scriptArg = args.find((a) => a.endsWith("gemini-mcp.mjs"));
  assert.ok(scriptArg && path.isAbsolute(scriptArg) && fs.existsSync(scriptArg), `.mcp.json must resolve gemini-mcp.mjs to an existing absolute path, got: ${scriptArg}`);

  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-launch-"));
  const child = spawn(command, args, { cwd: tempCwd, stdio: ["pipe", "pipe", "pipe"] });

  try {
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
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`MCP server exited early (code ${code}) -- it likely could not find its script from this cwd`)); });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);

    const reply = JSON.parse(await firstLine);
    assert.equal(reply.id, 1);
    assert.equal(reply.result.serverInfo.name, "gemini");
    assert.equal(typeof reply.result.protocolVersion, "string");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});
