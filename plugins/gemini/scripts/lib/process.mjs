import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

// This is not a reliable cmd.exe escaper: embedded quotes toggle cmd's parse
// state, and backslashes escape quotes for MSVCRT children, not for cmd.exe.
// Keep it only as a belt-and-suspenders safety net for fixed or validated argv
// used by remaining bare-name command paths (where/gemini/taskkill), never
// as protection for free text. Gemini and AGY >=1.1.2 prompts use stdin; older
// AGY positional prompts are protected by absolute-path resolution and
// therefore shell:false instead.
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

export function runCommand(command, args = [], options = {}) {
  const shell = options.shell ?? (process.platform === "win32" && !path.isAbsolute(command));
  const safeCommand = shell ? quoteForWindowsShell(command) : command;
  const safeArgs = shell ? args.map(quoteForWindowsShell) : args;
  const result = spawnSync(safeCommand, safeArgs, {
    cwd: options.cwd,
    env: options.env,
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
  const result = runCommand(finder, [command]);
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

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
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
