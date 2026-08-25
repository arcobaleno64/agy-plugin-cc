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

// The two hosts that read this manifest disagree about it, and neither reading
// is negotiable:
//
//   Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} in command/args/env, and has
//   no cwd field at all -- the server inherits the host's working directory.
//
//   Codex passes command/args/env through literally (verified with
//   `codex mcp get gemini --json`) and resolves cwd against the plugin
//   directory. A ${CLAUDE_PLUGIN_ROOT} in args reaches node as those 21
//   characters; a ${CLAUDE_PLUGIN_ROOT} in cwd fails process creation on
//   Windows with ERROR_DIRECTORY (267).
//
// So the manifest carries the plugin root twice -- expanded through env for the
// host that substitutes, and implied by cwd for the host that does not -- and
// the bootstrap in args picks whichever one arrived intact. Each case below is
// one host's reading; all three must answer initialize.
async function initialize(t, { cwd, expand, dropEnv }) {
  const ex = (s) => (expand ? s.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT) : s);

  // Each case must pin exactly one host's reading, so the manifest's own entry is
  // the only source of GEMINI_PLUGIN_ROOT. Inheriting it would let "Codex
  // forwards no env at all" quietly take the env path and pass for the wrong
  // reason -- and it is genuinely set in the environment whenever this suite is
  // run from a turn delegated through this plugin.
  const env = { ...process.env };
  delete env.GEMINI_PLUGIN_ROOT;
  if (!dropEnv) {
    for (const [key, value] of Object.entries(SERVER.env ?? {})) env[key] = ex(value);
  }

  const child = spawn(ex(SERVER.command), SERVER.args.map(ex), {
    cwd,
    env,
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
      // bootstrap loaded a module that then started no stdio loop.
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

test("the manifest never puts a placeholder anywhere Codex reads literally", () => {
  assert.equal(SERVER.cwd, ".", "cwd must be the plugin dir by relative path, never ${CLAUDE_PLUGIN_ROOT}");
  assert.ok(!SERVER.command.includes("${"), "command must not carry a placeholder");
  for (const arg of SERVER.args) {
    assert.ok(!arg.includes("${CLAUDE_PLUGIN_ROOT}"), `args must not carry a placeholder Codex would pass through: ${arg}`);
  }
  assert.equal(SERVER.env?.GEMINI_PLUGIN_ROOT, "${CLAUDE_PLUGIN_ROOT}", "env is where the substituting host hands over the plugin root");
});

test("Claude Code's reading launches the server: placeholders expanded, cwd inherited", async (t) => {
  const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-mcp-launch-"));
  try {
    const reply = await initialize(t, { cwd: tempCwd, expand: true });
    assert.equal(reply.id, 1);
    assert.equal(reply.result.serverInfo.name, "gemini");
    assert.equal(typeof reply.result.protocolVersion, "string");
  } finally {
    fs.rmSync(tempCwd, { recursive: true, force: true });
  }
});

test("Codex's reading launches the server: args literal, cwd is the plugin dir", async (t) => {
  const reply = await initialize(t, { cwd: PLUGIN_ROOT, expand: false });
  assert.equal(reply.result.serverInfo.name, "gemini");
});

test("Codex's reading still launches the server when it forwards no env at all", async (t) => {
  const reply = await initialize(t, { cwd: PLUGIN_ROOT, expand: false, dropEnv: true });
  assert.equal(reply.result.serverInfo.name, "gemini");
});

test("importing the server module starts no stdio loop", async () => {
  const module = await import(new URL("../plugins/gemini/scripts/gemini-mcp.mjs", import.meta.url));
  assert.ok(module, "module must import without taking over stdin");
});

test("the bootstrap arg carries no character cmd.exe would read as an operator", () => {
  // Hosts spawn `node` directly today, so this string reaches argv verbatim. It
  // is one `shell: true` away from being parsed instead -- a common Windows
  // workaround for resolving .cmd shims -- and there `>` is a redirect that
  // creates a file and `|` splits the command. The bootstrap is expressible
  // without any of them at no behavioral cost, so it is.
  const bootstrap = SERVER.args.find((a) => a.includes("gemini-mcp.mjs"));
  for (const ch of [">", "<", "|", "&", "^"]) {
    assert.ok(!bootstrap.includes(ch), `bootstrap must not contain ${ch}, which cmd.exe would treat as an operator`);
  }
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
