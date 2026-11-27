import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";
import { isSecretFile } from "./secrets.mjs";

const BASELINE_SECRET_RELATIVE_PATHS = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.test",
  ".npmrc",
  ".netrc"
];

const SKIPPED_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "vendor"
]);

const CUSTOMIZATION_DIR_NAMES = [".agents", ".agent", "_agents", "_agent"];
const CUSTOMIZATION_FILES = ["hooks.json", "mcp_config.json", "plugins.json"];

/**
 * Encode a workspace-relative path into an AGY permission rule (`action(target)`).
 * Rejects traversal (`..`), parentheses, and control characters so a malformed
 * filename cannot alter permission-rule parsing.
 */
export function encodeAgyPathRule(action, relativePath) {
  if (typeof action !== "string" || !action || typeof relativePath !== "string") {
    return null;
  }
  if (process.platform !== "win32" && relativePath.includes("\\")) {
    return null;
  }
  const normalized = (process.platform === "win32" ? relativePath.replace(/\\/g, "/") : relativePath)
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+$/, "");
  if (!normalized) return null;
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  if (/[\x00-\x1f\x7f()]/.test(normalized)) return null;
  if (normalized.split("/").some((segment) => segment === "..")) return null;
  return `${action}(${normalized})`;
}

/**
 * Walk `cwd` (including gitignored files, bounded by depth/entry caps and
 * without following directory symlinks) to emit relative `read_file(...)` deny
 * rules for existing secret stores. Relative rules avoid AGY's Windows
 * drive-letter stripping mismatch on `D:` and still block traversal/symlinks.
 */
export function collectWorkspaceSecretDenyRules(
  cwd,
  { maxEntries = 5000, maxDepth = 6, opendirSyncFn = fs.opendirSync } = {}
) {
  const rules = new Set();
  for (const basePath of BASELINE_SECRET_RELATIVE_PATHS) {
    const encoded = encodeAgyPathRule("read_file", basePath);
    if (encoded) rules.add(encoded);
  }

  let budgetExhausted = false;
  let depthTruncated = false;
  let skippedUnsafeNames = 0;
  let readErrors = 0;
  let skippedSymlinkDirs = 0;
  let symlinkErrors = 0;
  let rootDirOpened = false;
  const skippedFixedDirsObserved = new Set();

  const buildResult = (rootScanned) => ({
    rules: [...rules],
    rootScanned,
    truncated: budgetExhausted || depthTruncated,
    budgetExhausted,
    depthTruncated,
    skippedUnsafeNames,
    readErrors,
    skippedSymlinkDirs,
    symlinkErrors,
    skippedFixedDirsConfig: [...SKIPPED_SCAN_DIRS],
    skippedFixedDirsObserved: [...skippedFixedDirsObserved]
  });

  if (!cwd || typeof cwd !== "string") {
    readErrors += 1;
    return buildResult(false);
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync.native(cwd);
    if (!fs.statSync(realRoot).isDirectory()) {
      readErrors += 1;
      return buildResult(false);
    }
  } catch {
    readErrors += 1;
    return buildResult(false);
  }

  const stack = [{ dir: realRoot, rel: "", depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    let dirHandle;
    try {
      dirHandle = opendirSyncFn(current.dir);
      if (current.depth === 0) {
        rootDirOpened = true;
      }
    } catch {
      readErrors += 1;
      continue;
    }

    try {
      let entry;
      while ((entry = dirHandle.readSync()) !== null) {
        visited += 1;
        if (visited > maxEntries) {
          budgetExhausted = true;
          break;
        }
        const relPath = current.rel ? `${current.rel}/${entry.name}` : entry.name;
        const fullPath = path.join(current.dir, entry.name);

        if (entry.isDirectory()) {
          if (SKIPPED_SCAN_DIRS.has(entry.name)) {
            skippedFixedDirsObserved.add(relPath);
            continue;
          }
          if (current.depth < maxDepth) {
            stack.push({ dir: fullPath, rel: relPath, depth: current.depth + 1 });
          } else {
            depthTruncated = true;
          }
          continue;
        }

        const nameMatched = isSecretFile(entry.name);
        let targetIsSecret = false;
        let isDirSymlink = false;
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              isDirSymlink = true;
              skippedSymlinkDirs += 1;
            } else {
              const target = fs.realpathSync.native(fullPath);
              targetIsSecret = isSecretFile(target);
            }
          } catch {
            symlinkErrors += 1;
          }
        }

        if (nameMatched || (!isDirSymlink && targetIsSecret)) {
          const encoded = encodeAgyPathRule("read_file", relPath);
          if (encoded) {
            rules.add(encoded);
          } else {
            skippedUnsafeNames += 1;
          }
        }
      }
    } catch {
      readErrors += 1;
    } finally {
      try {
        dirHandle.closeSync();
      } catch {
        // Ignore close failure.
      }
    }

    if (budgetExhausted) break;
  }

  return buildResult(rootDirOpened);
}

/**
 * Build a one-shot AGY `--settings` JSON object for the requested execution mode.
 * `write` mode intentionally keeps command execution available (and does not
 * force Windows AppContainer sandboxing) while guarding `.git` and secrets.
 */
export function buildAgySettingsPayload({ mode, workspaceDir = null, secretDenyRules = [] }) {
  const uniqueSecrets = [...new Set(secretDenyRules)].filter((r) => typeof r === "string" && r.length > 0);
  if (mode === "review-diff") {
    return {
      toolPermission: "request-review",
      agentMode: "",
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: [],
      permissions: {
        deny: ["read_file(*)", "write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)"]
      }
    };
  }
  if (mode === "read-only") {
    return {
      toolPermission: "request-review",
      agentMode: "",
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: workspaceDir ? [workspaceDir] : [],
      permissions: {
        deny: ["write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)", ...uniqueSecrets]
      }
    };
  }
  if (mode === "write") {
    return {
      allowNonWorkspaceAccess: false,
      trustedWorkspaces: workspaceDir ? [workspaceDir] : [],
      permissions: {
        deny: ["write_file(.git/)", "write_file(.git)", ...uniqueSecrets]
      }
    };
  }
  throw new Error(`Unknown AGY settings mode "${mode}".`);
}

function isMissingOrNotDir(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

const GIT_DISCOVERY_ENV_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM"
];

/**
 * Inspect `cwd` up to the repository root for auto-loaded AGY customization
 * files (`hooks.json`, `mcp_config.json`, `plugins`), which AGY headless runs
 * execute even outside `trustedWorkspaces`.
 */
export function inspectWorkspaceCustomizations(cwd, { maxParentHops = 64, runCommandFn = runCommand } = {}) {
  if (!cwd || typeof cwd !== "string") {
    return {
      checked: false,
      missingCwd: false,
      notDirectory: true,
      repoRootStatus: "unverified",
      repoRootResolved: false,
      hopLimitReached: false,
      scope: "none",
      found: [],
      error: "cwd must be a non-empty directory path"
    };
  }

  let startDir;
  try {
    startDir = fs.realpathSync.native(cwd);
    if (!fs.statSync(startDir).isDirectory()) {
      return {
        checked: false,
        missingCwd: false,
        notDirectory: true,
        repoRootStatus: "unverified",
        repoRootResolved: false,
        hopLimitReached: false,
        scope: "none",
        found: [],
        error: "cwd is not a directory"
      };
    }
  } catch (error) {
    if (isMissingOrNotDir(error)) {
      return {
        checked: false,
        missingCwd: true,
        notDirectory: false,
        repoRootStatus: "unverified",
        repoRootResolved: false,
        hopLimitReached: false,
        scope: "none",
        found: [],
        error: null
      };
    }
    return {
      checked: false,
      missingCwd: false,
      notDirectory: false,
      repoRootStatus: "unverified",
      repoRootResolved: false,
      hopLimitReached: false,
      scope: "none",
      found: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }

  let stopDir = startDir;
  let repoRootResolved = false;
  let repoRootStatus = "error";
  let scope = "unverified";
  let rootError = null;
  try {
    const activeGitEnvOverrides = GIT_DISCOVERY_ENV_VARS.filter((name) =>
      Object.prototype.hasOwnProperty.call(process.env, name)
    );
    if (activeGitEnvOverrides.length > 0) {
      rootError = `Git discovery environment override (${activeGitEnvOverrides.join(", ")}) is set; refusing unverified repository root resolution`;
    } else {
      const gitRes = runCommandFn("git", ["rev-parse", "--show-toplevel"], {
        cwd: startDir,
        shell: false,
        maxBuffer: 1024 * 1024
      });
      const gitStderr = String(gitRes.stderr ?? "");
      if (!gitRes.error && gitRes.status === 0 && String(gitRes.stdout ?? "").trim()) {
        const candidateRoot = fs.realpathSync.native(String(gitRes.stdout).trim());
        const relCheck = path.relative(candidateRoot, startDir);
        if (!relCheck.startsWith("..") && !path.isAbsolute(relCheck)) {
          stopDir = candidateRoot;
          repoRootResolved = true;
          repoRootStatus = "resolved";
          scope = "repo-root";
        } else {
          rootError = "git repository root is not an ancestor of cwd";
        }
      } else if (
        !gitRes.error &&
        gitRes.status !== 0 &&
        /^fatal:\s*not a git repository \(or any (?:of the )?parent directories\):\s*\.git$/i.test(gitStderr.trim())
      ) {
        repoRootStatus = "not-a-git-repo";
        scope = "start-dir-only";
        stopDir = startDir;
      } else {
        rootError = gitRes.error
          ? (gitRes.error instanceof Error ? gitRes.error.message : String(gitRes.error))
          : (gitStderr.trim() || `git rev-parse exited with status ${gitRes.status}`);
      }
    }
  } catch (error) {
    rootError = error instanceof Error ? error.message : String(error);
  }

  const found = [];
  let checked = repoRootStatus !== "error";
  let inspectError = rootError;
  let hopLimitReached = false;
  let current = startDir;

  for (let hop = 0; hop < maxParentHops; hop += 1) {
    for (const dirName of CUSTOMIZATION_DIR_NAMES) {
      const custDir = path.join(current, dirName);
      let dirStat;
      try {
        dirStat = fs.lstatSync(custDir);
      } catch (error) {
        if (!isMissingOrNotDir(error)) {
          checked = false;
          inspectError = inspectError ?? (error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
        if (dirStat.isSymbolicLink()) {
          found.push(path.relative(stopDir, custDir).replace(/\\/g, "/") || dirName);
        }
        continue;
      }

      for (const fileName of CUSTOMIZATION_FILES) {
        const candidate = path.join(custDir, fileName);
        try {
          fs.lstatSync(candidate);
          found.push(path.relative(stopDir, candidate).replace(/\\/g, "/"));
        } catch (error) {
          if (!isMissingOrNotDir(error)) {
            checked = false;
            inspectError = inspectError ?? (error instanceof Error ? error.message : String(error));
          }
        }
      }

      const pluginsDir = path.join(custDir, "plugins");
      try {
        const pluginsStat = fs.lstatSync(pluginsDir);
        if (pluginsStat.isSymbolicLink() || (pluginsStat.isDirectory() && fs.readdirSync(pluginsDir).length > 0)) {
          found.push(path.relative(stopDir, pluginsDir).replace(/\\/g, "/"));
        }
      } catch (error) {
        if (!isMissingOrNotDir(error)) {
          checked = false;
          inspectError = inspectError ?? (error instanceof Error ? error.message : String(error));
        }
      }
    }

    if (current === stopDir) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    if (hop === maxParentHops - 1) {
      hopLimitReached = true;
      checked = false;
      inspectError = inspectError ?? `reached ${maxParentHops}-directory parent traversal limit before repository root`;
      break;
    }
    current = parent;
  }

  return {
    checked,
    missingCwd: false,
    notDirectory: false,
    repoRootStatus,
    repoRootResolved,
    hopLimitReached,
    scope,
    found: [...new Set(found)],
    error: inspectError
  };
}

/**
 * Create an isolated temporary directory for one AGY invocation (holding an
 * optional UTF-8 no-BOM `settings.json` and/or empty `cwd/`), and remove it on
 * completion without masking any error thrown by `fn`.
 */
export async function withAgyTempContext(
  { settingsPayload = null, isolatedCwd = false, onCleanupError = null, rmSyncFn = fs.rmSync } = {},
  fn
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-plugin-cc-"));
  try {
    try {
      fs.chmodSync(tempRoot, 0o700);
    } catch {
      // chmod may be a partial no-op on Windows; mkdtemp under user temp is already user-scoped.
    }

    let settingsFile = null;
    if (settingsPayload != null) {
      settingsFile = path.join(tempRoot, "settings.json");
      fs.writeFileSync(settingsFile, `${JSON.stringify(settingsPayload, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    }

    let isolatedCwdPath = null;
    if (isolatedCwd) {
      isolatedCwdPath = path.join(tempRoot, "cwd");
      fs.mkdirSync(isolatedCwdPath, { mode: 0o700 });
    }

    return await fn({ tempRoot, settingsFile, isolatedCwdPath });
  } finally {
    let cleanupErr = null;
    try {
      rmSyncFn(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (cleanupError) {
      cleanupErr = cleanupError;
    }
    if (cleanupErr !== null) {
      try {
        Promise.resolve(onCleanupError?.(cleanupErr)).catch(() => {});
      } catch {
        // Never allow telemetry callback errors to mask `fn` results or errors.
      }
      try {
        process.stderr.write(
          `[gemini-companion] Warning: failed to remove temporary AGY directory ${tempRoot}: ${
            cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
          }\n`
        );
      } catch {
        // Ignore stderr write failure during cleanup.
      }
    }
  }
}
