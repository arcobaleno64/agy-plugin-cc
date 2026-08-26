import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// This is not a reliable cmd.exe escaper: embedded quotes toggle cmd's parse
// state, and backslashes escape quotes for MSVCRT children, not for cmd.exe.
// Keep it only as a belt-and-suspenders safety net for fixed or validated argv,
// never as protection for free text. Gemini and AGY >=1.1.2 prompts use stdin;
// older AGY positional prompts are protected by absolute-path resolution and
// therefore shell:false instead.
// As of v0.16.2 the shell is a *fallback*: a bare command name is resolved to an
// absolute executable, or to a Node entry script, and spawned with shell:false
// (see resolveSpawnTarget below). This function still runs for the cases that
// resolution cannot identify, so it is not dead — just no longer the norm.
// Exported for tests only: the escaping rules below are Windows/MSVCRT specific
// and are NOT equivalent under POSIX sh (`"a\\ "` loses a backslash there), so
// they can only be asserted on the returned string, not by round-tripping argv
// through a shell on Linux CI. Do not call this from other modules.
const WINDOWS_SHELL_UNSAFE = /[\s|<>&()^"]/;
export function quoteForWindowsShell(arg) {
  if (typeof arg !== "string" || !WINDOWS_SHELL_UNSAFE.test(arg)) return arg;
  // MSVCRT argv rules: a backslash is literal EXCEPT before a quote, where each
  // one must be doubled, and a run at the end must be doubled so it does not
  // escape the closing quote. Replacing only `"` left `a\` + `"` as `a\\"`,
  // which the child reads as a literal backslash and a closing quote — the
  // caller's value escapes its own quoting. This does not make the function a
  // cmd.exe escaper; see the note above for why that is not attempted.
  const escaped = arg
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, "$1$1");
  return `"${escaped}"`;
}

// --- avoiding the shell on Windows -----------------------------------------
// A bare command name has to be resolved before it can be spawned, and the
// historical way to do that here was `shell: true`, which concatenates argv
// into a command line rather than passing it literally (Node 24 warns about
// exactly this: DEP0190). Everything below exists to reach `shell: false`
// wherever the target can be identified with confidence, and to fall back to
// the old behavior — never to a guess — wherever it cannot.

const spawnTargetCache = new Map();

export function resetSpawnTargetCacheForTesting() {
  spawnTargetCache.clear();
}

// where.exe and taskkill.exe live in System32. Resolving them there rather than
// through PATH also avoids executing a same-named binary planted earlier in it.
function windowsSystemTool(name) {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!root) return null;
  const full = path.join(root, "System32", `${name}.exe`);
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

// where.exe searches the CURRENT DIRECTORY before PATH, and -- unlike cmd.exe and
// CreateProcess -- it keeps doing so when NoDefaultCurrentDirectoryInExePath is
// set. Measured: with a stray `git.exe` in the working tree, `where git` returns
// that copy first and every caller here trusts the first hit, so opening a
// repository was enough to get its binary spawned. The lookup therefore runs
// from a directory the workspace cannot write to. System32 is already on PATH
// and needs administrator rights to write, so naming it as the lookup's cwd
// introduces no candidate that was not already trusted.
// Taken from where.exe's own resolved location rather than re-derived from the
// environment. That makes the invariant structural: if there is a tool to run,
// there is a directory it lives in, and no branch exists where this returns
// nothing while the lookup still goes ahead.
//
// The first attempt read %SystemRoot% a second time and fell back when it was
// missing. That fallback was unreachable -- windowsSystemTool needs the same
// variable, so a missing %SystemRoot% means there is no `where` to run either and
// computeSpawnTarget has already returned null. A mutation replacing the fallback
// survived the whole suite, which is what said so.
//
// `undefined` here now means only "no System32\\where.exe at all". Both callers
// are safe in that state: computeSpawnTarget returns null and the shell branch
// below sets NoDefaultCurrentDirectoryInExePath, and resolveBinaryPath's own
// spawn takes the same branch.
function lookupCwd() {
  const where = windowsSystemTool("where");
  return where ? path.dirname(where) : undefined;
}

// powershell.exe is the one tool here that does not live in System32 itself.
// Resolved absolutely for the same reason where.exe and taskkill.exe are: a
// same-named binary planted earlier in PATH must not be able to answer.
function windowsPowerShell() {
  const root = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!root) return null;
  const full = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    return fs.statSync(full).isFile() ? full : null;
  } catch {
    return null;
  }
}

// An npm global "binary" on Windows is a shim, not an executable: `gemini` is a
// sh script and `gemini.cmd` a batch file, and running either needs a shell.
// Both do the same thing — invoke `node <pkg>/<entry>.js` — and that command can
// be spawned directly.
//
// The shim text says which package, but NOT reliably which entry: npm's own shim
// names both `npm-cli.js` and `npm-prefix.js`, and picking the first match runs
// the wrong program while still exiting 0. So the shim is used only to find the
// package, and the entry comes from that package's `bin` field, which is the
// authority on what the command name maps to.
//
// Returns the entry script, or null when nothing can be established with
// confidence — the signal to leave the old shell path alone.
//
// Exported for tests only: both rules above came from real misresolutions and
// nothing else in the suite would catch them regressing.
export function resolveNodeShimEntry(shimPath, commandName) {
  let source;
  try {
    if (!fs.statSync(shimPath).isFile()) return null;
    source = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }

  const shimDir = path.dirname(shimPath);
  // "@scope/name" or "name", in either slash direction:
  //   "%dp0%\node_modules\@google\gemini-cli\bundle\gemini.js"
  //   "$basedir/node_modules/npm/bin/npm-cli.js"
  const packages = new Set();
  for (const match of source.matchAll(/node_modules[\\/](@[^\\/"'\s]+[\\/])?([^\\/"'\s]+)/g)) {
    packages.add(`${match[1] ? match[1].replace(/[\\/]/g, "/") : ""}${match[2]}`);
  }

  for (const pkg of packages) {
    const entry = entryFromPackageBin(shimDir, pkg, commandName);
    if (entry) return entry;
  }
  return null;
}

function entryFromPackageBin(shimDir, pkg, commandName) {
  const pkgDir = path.join(shimDir, "node_modules", ...pkg.split("/"));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  } catch {
    return null;
  }

  // `bin` is either { <command>: <path> } or a bare string, which npm treats as
  // the package's own name. Anything else, or a name that does not match what
  // was asked for, is not this command.
  const bin = manifest?.bin;
  const relative = typeof bin === "string"
    ? (manifest.name === commandName || path.basename(String(manifest.name ?? "")) === commandName ? bin : null)
    : (bin && typeof bin === "object" ? bin[commandName] : null);
  if (typeof relative !== "string" || !relative) return null;

  // A shim pointing outside its own directory is not one this code will follow.
  // Reading a shim is cheap; executing whatever it names is not.
  let realDir, realEntry;
  try {
    realDir = fs.realpathSync.native(shimDir);
    realEntry = fs.realpathSync.native(path.resolve(pkgDir, relative));
    if (!fs.statSync(realEntry).isFile()) return null;
  } catch {
    return null;
  }
  const contained = path.relative(realDir, realEntry);
  if (!contained || contained.startsWith("..") || path.isAbsolute(contained)) return null;

  return realEntry;
}

// Resolve a bare command name to something spawnable with shell:false.
// Returns null when that cannot be done, meaning: keep the previous behavior.
//
// Keyed by PATH as well as the name: a caller may pass its own env — the test
// fixtures do exactly that to shadow a real CLI — and the same name resolves to
// a different program under a different PATH.
function resolveSpawnTarget(command, env) {
  const searchPath = String(env?.PATH ?? env?.Path ?? process.env.PATH ?? "");
  const key = `${command}\u001f${searchPath}`;
  if (spawnTargetCache.has(key)) return spawnTargetCache.get(key);

  const target = computeSpawnTarget(command, env);
  spawnTargetCache.set(key, target);
  return target;
}

function computeSpawnTarget(command, env) {
  const systemTool = windowsSystemTool(command);
  if (systemTool) return { command: systemTool, prefixArgs: [] };

  const where = windowsSystemTool("where");
  if (!where) return null;

  // shell:false explicitly: this is the call that would otherwise recurse. The
  // caller's env decides what is on PATH, so the lookup must run under it.
  const found = spawnSync(where, [command], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    // Not the caller's cwd: see lookupCwd. The caller's env still decides PATH.
    cwd: lookupCwd(),
    ...(env ? { env } : {})
  });
  // where.exe consults PATH and PATHEXT, so a non-zero status means the command
  // is not on this machine. Spawning the bare name without a shell then fails
  // with ENOENT, which every caller already handles — and does so without
  // routing a doomed lookup through cmd.exe just to get the same answer.
  if (found.status !== 0) return { command, prefixArgs: [] };

  const matches = String(found.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && path.isAbsolute(line));
  if (matches.length === 0) return null;

  // Only the first PATH directory may answer. where.exe reports every match in
  // PATH order, and a shell would run the first one; searching further would
  // pick a *different installation* whenever the nearest one is not
  // recognizable — which is how a test fixture's stand-in got silently replaced
  // by the real CLI sitting later in PATH.
  const firstDir = path.dirname(matches[0]);
  const candidates = matches.filter((match) => path.dirname(match) === firstDir);

  // A real executable needs no shim handling and no shell.
  const executable = candidates.find((c) => [".exe", ".com"].includes(path.extname(c).toLowerCase()));
  if (executable) return { command: executable, prefixArgs: [] };

  // Otherwise look for a Node shim and run its entry script through this very
  // Node, which is already a trusted absolute path.
  for (const candidate of candidates) {
    const entry = resolveNodeShimEntry(candidate, command);
    if (entry) return { command: process.execPath, prefixArgs: [entry] };
  }
  return null;
}

export function runCommand(command, args = [], options = {}) {
  let spawnCommand = command;
  let spawnArgs = args;
  let shell = options.shell ?? (process.platform === "win32" && !path.isAbsolute(command));

  if (shell && options.shell !== true) {
    const target = resolveSpawnTarget(command, options.env);
    if (target) {
      spawnCommand = target.command;
      spawnArgs = [...target.prefixArgs, ...args];
      shell = false;
    }
  }

  const safeCommand = shell ? quoteForWindowsShell(spawnCommand) : spawnCommand;
  const safeArgs = shell ? spawnArgs.map(quoteForWindowsShell) : spawnArgs;

  // The fallback shell is cmd.exe, and cmd.exe searches the current directory
  // before PATH. Measured: with no NoDefaultCurrentDirectoryInExePath set, a
  // `git.cmd` sitting in the working tree wins over the real git. Git Bash sets
  // that variable, which is why this stayed invisible here -- a plain PowerShell
  // or cmd session does not, and neither does a service. Setting it for the
  // child is Microsoft's own switch for exactly this case.
  //
  // Set ONLY on the shell branch, and this is deliberate rather than tidy.
  // `spawnSync` with `shell:false` never searches the current directory, so the
  // flag buys nothing there -- and this same function spawns the engine CLI,
  // which passes its environment on to every shell command the model runs. An
  // unconditional flag would change command resolution inside the user's own
  // workspace for those grandchildren, where a repo-local helper invoked by bare
  // name would stop resolving. That is a behaviour change outside this plugin's
  // own spawns, and not one to make as a side effect of keeping two branches
  // symmetrical.
  //
  // Leaving `options.env` untouched on the other branch also preserves
  // spawnSync's inherit-by-default, which is not the same thing as
  // `{ ...process.env }`: Node's env proxy hides the `=C:` per-drive
  // current-directory entries cmd.exe maintains, so rebuilding the block drops
  // them.
  const env = shell ? { ...(options.env ?? process.env), NoDefaultCurrentDirectoryInExePath: "1" } : options.env;

  const result = spawnSync(safeCommand, safeArgs, {
    cwd: options.cwd,
    env,
    encoding: "utf8",
    input: options.input,
    stdio: options.stdio ?? "pipe",
    // Absolute paths are spawned directly (shell:false) so arguments are passed
    // literally and never re-parsed by the shell. Bare command names still use the
    // shell on Windows to resolve .cmd/.ps1 wrappers (npm global bins).
    shell,
    windowsHide: true,
    ...(options.maxBuffer != null && { maxBuffer: options.maxBuffer }),
    ...(options.timeout != null && { timeout: options.timeout }),
  });

  return {
    command,
    args,
    // null status means killed by signal or failed to spawn — treat as failure
    status: result.status ?? (result.signal ? 1 : (result.error ? 1 : 0)),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function resolveBinaryPath(command, { requireExe = false } = {}) {
  if (path.isAbsolute(command)) {
    return !requireExe || path.extname(command).toLowerCase() === ".exe" ? command : null;
  }
  const finder = process.platform === "win32" ? "where" : "which";
  // Same reason as computeSpawnTarget: this takes candidates[0], and run from
  // the workspace `where` puts the workspace's own copy there. `which` does not
  // consult the current directory, so this is a no-op off Windows.
  const result = runCommand(finder, [command], { cwd: lookupCwd() });
  if (result.status !== 0) {
    return null;
  }
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && path.isAbsolute(line));
  const resolved = requireExe
    ? candidates.find((candidate) => path.extname(candidate).toLowerCase() === ".exe")
    : candidates[0];
  return resolved ?? null;
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

/**
 * Whether a pid still identifies a live process. EPERM counts as alive: the
 * process exists, this one simply may not signal it.
 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// `taskkill /F` returns before the kernel has finished tearing the process down,
// so a single immediate check can still see it. Bounded and short: this only
// runs on the path where taskkill already reported trouble.
const TERMINATION_SETTLE_TRIES = 6;
const TERMINATION_SETTLE_MS = 50;

function waitForPidToExit(pid, isAlive) {
  for (let attempt = 0; attempt < TERMINATION_SETTLE_TRIES; attempt += 1) {
    if (!isAlive(pid)) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TERMINATION_SETTLE_MS);
  }
  return !isAlive(pid);
}

/**
 * Direct children of `pid`, with the time each was created.
 *
 * Windows keeps a process's parent link after the parent exits, so this still
 * answers for a pid that was just killed — measured on this repository: a query
 * by a killed parent's pid returned its orphan along with the orphan's creation
 * time. taskkill cannot stand in for it, because a second pass over a dead pid
 * exits 128 "not found" without walking anything.
 */
export function listChildProcesses(pid, options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const shell = options.powerShellPath ?? windowsPowerShell();
  if (!shell || !Number.isFinite(pid)) {
    return { available: false, children: [] };
  }

  // 'o' is the round-trip format: invariant, so unlike taskkill's own output
  // this does not change meaning with the machine's locale.
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}" | `
    + `ForEach-Object { "$($_.ProcessId)|$($_.CreationDate.ToString('o'))" }`;
  const result = runCommandImpl(shell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    cwd: options.cwd,
    env: options.env
  });
  if (result.error || result.status !== 0) {
    return { available: false, children: [] };
  }

  // Having no children is a real answer, and it reads as empty stdout.
  const children = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawPid, rawCreated] = line.split("|");
      return { pid: Number(rawPid), createdAt: Date.parse(rawCreated ?? "") };
    })
    .filter((child) => Number.isFinite(child.pid) && Number.isFinite(child.createdAt));
  return { available: true, children };
}

// What a cancel cannot otherwise know: whether the engine the worker started is
// still running. Usually it is not, and the tree walk is not why — measured on
// this repository, killing a worker with /F alone and no /T takes its engine with
// it. What performs that collection was not identified: the engines are in no job
// object (IsProcessInJob reports false for every live one), and it still happens
// with the stand-in's hold on stdin removed. What is established is that about 3%
// of cancels under load escape it and leave the engine running, and that taskkill
// called every one of those a clean kill.
//
// `notBefore` is load-bearing, not dressing. Pids are reused and Windows never
// clears a parent link, so a query by the worker's pid can name processes that
// belonged to an earlier owner of that number — the same stale-link problem the
// taskkill branch below documents. Those processes are older than this job, so
// their creation time is what separates the engine from a stranger. Without a
// start time this function would be a way to kill innocent processes, so without
// one it does nothing.
function sweepSurvivingChildren(pid, options) {
  const notBefore = Date.parse(options.notBefore ?? "");
  if (!Number.isFinite(notBefore)) {
    return { verified: false, killed: [], remaining: [] };
  }

  const listing = listChildProcesses(pid, options);
  if (!listing.available) {
    return { verified: false, killed: [], remaining: [] };
  }

  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const isAliveImpl = options.isPidAlive ?? isPidAlive;
  const killed = [];
  const remaining = [];
  for (const child of listing.children) {
    if (child.createdAt < notBefore) {
      continue;
    }
    runCommandImpl("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });
    (waitForPidToExit(child.pid, isAliveImpl) ? killed : remaining).push(child.pid);
  }
  return { verified: true, killed, remaining };
}

function withSweep(outcome, sweep) {
  return {
    ...outcome,
    ...(sweep.killed.length > 0 && { orphansKilled: sweep.killed }),
    ...(sweep.remaining.length > 0 && { orphansRemaining: sweep.remaining })
  };
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isAliveImpl = options.isPidAlive ?? isPidAlive;

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      // Exit 0 says the pid is gone, not that its tree is. And it says it early:
      // taskkill /F returns before the kernel has finished the teardown, so the
      // worker can still be running here — and a running worker can still start an
      // engine, which is the moment this whole sweep exists to catch. Asking now
      // would be asking a question whose answer can change after it is given.
      //
      // So wait for the pid to go first. A process that no longer exists cannot
      // start anything, which makes the set of children it left final: one query
      // sees all of it, and no second pass or settle delay can add to it. If it
      // does not go, the sweep still runs — anything it finds is still this job’s
      // — but the tree cannot be called finished.
      const settled = waitForPidToExit(pid, isAliveImpl);
      const sweep = sweepSurvivingChildren(pid, options);
      return withSweep({
        attempted: true,
        delivered: true,
        method: "taskkill",
        result,
        ...((sweep.remaining.length > 0 || !settled) && { treeIncomplete: true })
      }, sweep);
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    // taskkill /T walks Windows' PPID chain, and Windows never clears a parent
    // link when the parent exits. A reused pid therefore inherits whatever
    // processes still name it as their parent — observed on this repository's
    // own demo as two system processes taskkill then refused to terminate
    // ("the attempted operation is not supported"), which made exit 128 fatal
    // even though the job's worker had in fact been killed. /gemini:cancel then
    // reported failure, and the job was later reconciled as a stale one.
    //
    // So the question taskkill's exit code cannot answer is the only one that
    // matters: is the process gone? Measured rather than parsed — taskkill's
    // per-process SUCCESS and ERROR lines are localized, and reading them works
    // only in the locale the pattern was written for.
    if (!result.error && waitForPidToExit(pid, isAliveImpl)) {
      // taskkill named a descendant it could not kill, but measured on this
      // repository that is usually a stranger inherited through a reused pid: 15
      // of 36 cancels said this while 1 of 36 actually leaked. So report the swept
      // claim instead — something of this job is still running, or the sweep could
      // not run to find out.
      const sweep = sweepSurvivingChildren(pid, options);
      return withSweep({
        attempted: true,
        delivered: true,
        method: "taskkill",
        result,
        treeIncomplete: !(sweep.verified && sweep.remaining.length === 0)
      }, sweep);
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(pid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if (error?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        killImpl(pid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if (innerError?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
