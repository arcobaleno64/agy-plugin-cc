import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Gemini credential inspection, kept in its own module so engine.mjs can consult
// it without importing gemini.mjs (which imports engine.mjs). gemini.mjs
// re-exports these for existing callers.

// Gemini CLI 0.53.1 keeps credentials in the OS keychain via @github/keytar,
// under two fixed (service, account) pairs — read from the installed bundle,
// `apiKeyCredentialStorage.js` and `oauth-credential-storage.js`:
//
//   gemini-cli-api-key / default-api-key   the key pasted at the CLI's auth prompt
//   gemini-cli-oauth   / main-account      OAuth, migrated out of oauth_creds.json
//
// Neither is visible to an env-var or oauth_creds.json check, so a user who
// authenticated through the CLI itself looked unauthenticated to this plugin
// and `auto` routed past a working gemini.
export const GEMINI_KEYCHAIN_ENTRIES = Object.freeze([
  Object.freeze({ service: "gemini-cli-api-key", account: "default-api-key" }),
  Object.freeze({ service: "gemini-cli-oauth", account: "main-account" })
]);

const KEYCHAIN_PROBE_TIMEOUT_MS = 2000;

// One probe per entry per process. These are short-lived CLI processes and the
// keychain does not change mid-run, but `auto` routing consults this on every
// command, so an uncached probe would spawn on each one.
const keychainProbeCache = new Map();

export function resetKeychainProbeCacheForTesting() {
  keychainProbeCache.clear();
}

// Opt out of the probe entirely. Two reasons it exists: a user who would rather
// this plugin never spawn a credential tool can set it and lose only
// auto-routing accuracy, and the test suite needs a result that does not depend
// on whatever the machine running it happens to have in its keychain.
function keychainProbeDisabled(env) {
  return /^(1|true)$/i.test(String(env?.GEMINI_COMPANION_DISABLE_KEYCHAIN ?? "").trim());
}

// Presence only — never the secret. macOS and Linux report presence in the exit
// status, so their output is discarded unread; `cmdkey` has no such status and
// prints only metadata (target, type, user), never the credential value.
// Resolve a probe tool to an absolute path rather than trusting PATH.
//
// process.mjs already refuses to spawn a bare command name where it can avoid
// it, and says why: resolving a system tool in System32 "avoids executing a
// same-named binary planted earlier in PATH". This file was spawning `cmdkey`
// and `security` by bare name and so opted out of that reasoning for no reason.
//
// Measured, the exposure is narrower than it looks: Node's spawn does not search
// the current directory, so a cmdkey.exe sitting in a scanned repository is not
// executed. PATH order is still PATH order, though, and these probes run on
// every engine detection. Returning null when the tool cannot be located is the
// safe outcome — the caller already treats a failed probe as "no credential".
function absoluteProbeTool(platform, name, existsImpl = fs.existsSync) {
  if (platform === "win32") {
    const root = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!root) return null;
    const full = path.join(root, "System32", `${name}.exe`);
    return existsImpl(full) ? full : null;
  }
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    // path.posix, not path: these are POSIX locations, and on Windows — where
    // the test suite simulates other platforms — path.join would emit
    // backslashes for a path that is never a Windows path.
    const full = path.posix.join(dir, name);
    if (existsImpl(full)) return full;
  }
  return null;
}

function keychainProbeCommand(entry, platform, existsImpl) {
  const target = `${entry.service}/${entry.account}`;
  if (platform === "win32") {
    // A single-target query. `cmdkey /list` would enumerate every credential on
    // the machine, which is more of the user's data than this question needs.
    const cmdkey = absoluteProbeTool(platform, "cmdkey", existsImpl);
    if (!cmdkey) return null;
    return { command: cmdkey, args: [`/list:${target}`], readStdout: true };
  }
  if (platform === "darwin") {
    // No -w: without it the tool reports attributes and exits 0/44, and never
    // prints the password.
    const security = absoluteProbeTool(platform, "security", existsImpl);
    if (!security) return null;
    return { command: security, args: ["find-generic-password", "-s", entry.service, "-a", entry.account], readStdout: false };
  }
  if (platform === "linux") {
    // keytar stores libsecret items under the default Generic schema with these
    // two attributes. `search` rather than `lookup`, which prints the secret.
    const secretTool = absoluteProbeTool(platform, "secret-tool", existsImpl);
    if (!secretTool) return null;
    return { command: secretTool, args: ["search", "service", entry.service, "account", entry.account], readStdout: false };
  }
  return null;
}

// `cmdkey /list:<target>` exits 0 whether or not the target exists, so presence
// has to be read from the output — and the output is localized, so no message
// text can be matched. What is stable across locales: a hit repeats the account
// name on its own "User:" line, while a miss prints only the localized
// equivalent of "* NONE *". Removing every occurrence of "<service>/<account>"
// leaves the bare account name behind on a hit and nothing on a miss.
// Byte-compared as latin1 so a double-byte console codepage (verified against
// CP950) cannot corrupt the ASCII names being matched.
function cmdkeyOutputHasEntry(stdout, entry) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString("latin1") : String(stdout ?? "");
  return text.split(`${entry.service}/${entry.account}`).join("").includes(entry.account);
}

// True when the OS keychain holds this entry. False for every failure — tool
// missing, keychain locked, probe timeout, unsupported platform — because the
// caller's fallback is the previous behavior, and a wrong "authenticated" sends
// `auto` into an engine that rejects every request.
export function keychainEntryExists(entry, options = {}) {
  const { platform = process.platform, spawnImpl = spawnSync, env = process.env } = options;
  if (keychainProbeDisabled(env)) return false;
  const spec = keychainProbeCommand(entry, platform, options.existsImpl ?? fs.existsSync);
  if (!spec) return false;
  try {
    const result = spawnImpl(spec.command, spec.args, {
      timeout: KEYCHAIN_PROBE_TIMEOUT_MS,
      windowsHide: true,
      stdio: spec.readStdout ? ["ignore", "pipe", "ignore"] : ["ignore", "ignore", "ignore"]
    });
    if (!result || result.error || result.signal) return false;
    if (spec.readStdout) {
      return result.status === 0 && cmdkeyOutputHasEntry(result.stdout, entry);
    }
    return result.status === 0;
  } catch {
    return false;
  }
}

export function hasGeminiKeychainCredential(options = {}) {
  // Checked before the cache, not only inside the probe: a cached hit from an
  // earlier call would otherwise outlive the opt-out and answer for it.
  if (keychainProbeDisabled(options.env ?? process.env)) return false;
  for (const entry of GEMINI_KEYCHAIN_ENTRIES) {
    const key = `${entry.service}/${entry.account}`;
    if (!keychainProbeCache.has(key)) {
      keychainProbeCache.set(key, keychainEntryExists(entry, options));
    }
    if (keychainProbeCache.get(key)) return true;
  }
  return false;
}

function geminiHomeDir() {
  return process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini");
}

// `state` distinguishes the three ways `loggedIn: false` happens, because they
// are not equally informative and readiness has to tell them apart:
//
//   missing    — no file. Proves nothing: 0.53.1 migrates the file into the
//                keychain and deletes it, so a working install looks like this.
//   expired    — the file is there and says the token is stale. This is positive
//                evidence, and the only reason `/gemini:setup --engine gemini`
//                could have known not to report `ready` for an account that
//                answers API_KEY_INVALID on every request.
//   unreadable — present but not parseable. Unknown, not evidence.
//
// `verifiable: false` on every branch: this reads a file, it never asks the API.
// The shape matches probeAgyLogin/probeGeminiLogin so the readiness table can
// consume either without caring which produced it. `loggedIn` and `detail` are
// unchanged — render.mjs and hasGeminiCredentials read only those.
export function getGeminiLoginStatus() {
  const credFile = path.join(geminiHomeDir(), "oauth_creds.json");
  if (!fs.existsSync(credFile)) {
    return {
      loggedIn: false,
      state: "missing",
      verifiable: false,
      detail: `No credentials at ${credFile}. Run \`gemini\` to authenticate.`
    };
  }
  try {
    const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
    const expiry = creds?.expiry_date ?? creds?.expiry ?? creds?.token?.expiry_date;
    if (expiry && Date.now() > Number(expiry)) {
      return {
        loggedIn: false,
        state: "expired",
        verifiable: false,
        detail: `OAuth token expired at ${new Date(Number(expiry)).toISOString()}. Run \`gemini\` to re-authenticate.`
      };
    }
  } catch {
    return {
      loggedIn: false,
      state: "unreadable",
      verifiable: false,
      detail: `Cannot read credentials at ${credFile}. Run \`gemini\` to authenticate.`
    };
  }
  return { loggedIn: true, state: "valid", verifiable: false, detail: `OAuth credentials found at ${credFile}` };
}

// Personal (free) Gemini plans lose CLI access on 2026-06-18; Gemini Code Assist
// Standard/Enterprise do not. The selected auth type is recorded in
// ~/.gemini/settings.json as security.auth.selectedType (e.g. "oauth-personal").
export function getGeminiPlanTier() {
  const settingsFile = path.join(geminiHomeDir(), "settings.json");
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    const selectedType = settings?.security?.auth?.selectedType ?? null;
    if (typeof selectedType === "string") {
      return { tier: /personal/i.test(selectedType) ? "personal" : "other", selectedType };
    }
  } catch {
    // fall through to unknown
  }
  return { tier: "unknown", selectedType: null };
}

// Whether the gemini CLI has any credential it could actually use, checked in
// the order the CLI itself resolves them (0.53.1, `getAuthTypeFromEnv` and
// `createContentGeneratorConfig`):
//
//   1. GEMINI_API_KEY / GOOGLE_API_KEY in the environment — these bypass every
//      stored credential, so an API-key user with no oauth_creds.json must not
//      be treated as unauthenticated.
//   2. ~/.gemini/oauth_creds.json — the legacy OAuth file. Still written by
//      older CLIs and still read here, but 0.53.1 migrates it into the keychain
//      and deletes it, so its absence proves nothing on its own.
//   3. The OS keychain. Checked last because it is the only step that spawns.
//
// `/gemini:setup` reports the same notion as `geminiReady`. Auto-routing
// consults it so it cannot select a gemini binary that answers `--version` but
// rejects every request.
//
// Known gap: when no keychain is available the CLI falls back to an encrypted
// file at ~/.gemini/gemini-credentials.json, shared by every service and opaque
// without decrypting it. Its presence cannot distinguish a gemini credential
// from an unrelated MCP token, so it is deliberately not consulted — guessing
// there would reintroduce exactly the false "authenticated" this check exists
// to prevent. Affected users (headless Linux, WSL, or GEMINI_FORCE_FILE_STORAGE)
// can still select the engine explicitly with `--engine gemini`.
export function hasGeminiCredentials(options = {}) {
  // `env` is injectable so a caller that computes the rest of its answer from an
  // injected environment gets one consistent answer. Without it, buildSetupReport
  // could read an injected key for the credential *source* while this function
  // read the real environment for whether a credential exists at all — which is
  // how a setup test passed locally off an unrelated keychain entry and failed on
  // a runner that had none.
  const env = options.env ?? process.env;
  if (String(env.GEMINI_API_KEY ?? "").trim() || String(env.GOOGLE_API_KEY ?? "").trim()) {
    return true;
  }
  if (getGeminiLoginStatus().loggedIn) return true;
  return hasGeminiKeychainCredential(options);
}
