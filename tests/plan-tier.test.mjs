import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getGeminiPlanTier } from "../plugins/gemini/scripts/lib/gemini.mjs";
import {
  GEMINI_KEYCHAIN_ENTRIES,
  hasGeminiCredentials,
  keychainEntryExists,
  resetKeychainProbeCacheForTesting
} from "../plugins/gemini/scripts/lib/gemini-auth.mjs";

// getGeminiPlanTier reads $GEMINI_HOME/settings.json. Point it at a temp dir,
// write a settings file, assert, and always restore the env afterwards.
function withGeminiHome(settingsContent, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-home-"));
  if (settingsContent !== null) {
    fs.writeFileSync(path.join(home, "settings.json"), settingsContent, "utf8");
  }
  const prev = process.env.GEMINI_HOME;
  process.env.GEMINI_HOME = home;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GEMINI_HOME;
    else process.env.GEMINI_HOME = prev;
  }
}

function settings(selectedType) {
  return JSON.stringify({ security: { auth: { selectedType } } });
}

test("oauth-personal is classified as the personal (EOL) tier", () => {
  withGeminiHome(settings("oauth-personal"), () => {
    const t = getGeminiPlanTier();
    assert.equal(t.tier, "personal");
    assert.equal(t.selectedType, "oauth-personal");
  });
});

test("personal detection is case-insensitive / substring", () => {
  withGeminiHome(settings("OAuth-PERSONAL"), () => {
    assert.equal(getGeminiPlanTier().tier, "personal");
  });
});

test("a non-personal selectedType is classified as 'other'", () => {
  withGeminiHome(settings("oauth-enterprise"), () => {
    const t = getGeminiPlanTier();
    assert.equal(t.tier, "other");
    assert.equal(t.selectedType, "oauth-enterprise");
  });
});

test("missing settings.json yields tier 'unknown'", () => {
  withGeminiHome(null, () => {
    const t = getGeminiPlanTier();
    assert.equal(t.tier, "unknown");
    assert.equal(t.selectedType, null);
  });
});

test("malformed settings.json yields tier 'unknown'", () => {
  withGeminiHome("{not json", () => {
    assert.equal(getGeminiPlanTier().tier, "unknown");
  });
});

test("settings.json without an auth type yields tier 'unknown'", () => {
  withGeminiHome(JSON.stringify({ security: {} }), () => {
    assert.equal(getGeminiPlanTier().tier, "unknown");
  });
});

// hasGeminiCredentials backs the auto-routing decision. An API key bypasses the
// OAuth file entirely, so an API-key user must not be read as unauthenticated.
test("hasGeminiCredentials treats an API key as a credential", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const prevHome = process.env.GEMINI_HOME;
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_HOME = dir; // no oauth_creds.json here
  t.after(() => {
    if (prevHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = prevHome;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey;
  });

  // The keychain probe would otherwise consult the real keychain of whatever
  // machine runs this, which decides the assertion instead of the fixture.
  const noKeychain = { env: { GEMINI_COMPANION_DISABLE_KEYCHAIN: "1" } };

  delete process.env.GEMINI_API_KEY;
  assert.equal(hasGeminiCredentials(noKeychain), false);

  process.env.GEMINI_API_KEY = "  ";
  assert.equal(hasGeminiCredentials(noKeychain), false, "whitespace is not a credential");

  process.env.GEMINI_API_KEY = "AIza-test-key";
  assert.equal(hasGeminiCredentials(noKeychain), true);
});

// --- keychain probe ---
// gemini CLI 0.53.1 stores both the pasted API key and migrated OAuth tokens in
// the OS keychain, where neither an env-var check nor oauth_creds.json can see
// them. Every case below injects the spawn so it asserts the same way on all
// three platforms, including the two this machine cannot exercise for real.

const WIN_HIT = Buffer.from(
  "\r\nCurrently stored credentials for gemini-cli-api-key/default-api-key:\r\n\r\n" +
  "    Target: gemini-cli-api-key/default-api-key\r\n    Type: Generic\r\n    User: default-api-key\r\n",
  "latin1"
);
// A miss still names the target in its header line, which is why presence
// cannot be decided by searching for the target itself.
const WIN_MISS = Buffer.from(
  "\r\nCurrently stored credentials for gemini-cli-api-key/default-api-key:\r\n\r\n* NONE *\r\n",
  "latin1"
);

const API_KEY_ENTRY = GEMINI_KEYCHAIN_ENTRIES[0];

test("cmdkey output is read for presence, not exit status, and survives a localized console", () => {
  const spawnWith = (stdout, status = 0) => () => ({ status, stdout });

  assert.equal(
    keychainEntryExists(API_KEY_ENTRY, { platform: "win32", spawnImpl: spawnWith(WIN_HIT), env: {} }),
    true
  );
  assert.equal(
    keychainEntryExists(API_KEY_ENTRY, { platform: "win32", spawnImpl: spawnWith(WIN_MISS), env: {} }),
    false,
    "cmdkey exits 0 for a missing target, so status alone would report a false hit"
  );

  // CP950 console output for the same hit: the localized prose is double-byte,
  // the ASCII names are not. Decoding as latin1 keeps the bytes aligned.
  const cp950Hit = Buffer.concat([
    Buffer.from([0xa5, 0xd8, 0xa6, 0x73]), // localized prose bytes
    Buffer.from("\r\n    gemini-cli-api-key/default-api-key\r\n    default-api-key\r\n", "latin1")
  ]);
  assert.equal(
    keychainEntryExists(API_KEY_ENTRY, { platform: "win32", spawnImpl: spawnWith(cp950Hit), env: {} }),
    true
  );
});

test("macOS and Linux probes read presence from exit status and never request the secret", () => {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args });
    return { status: 0 };
  };

  assert.equal(keychainEntryExists(API_KEY_ENTRY, { platform: "darwin", spawnImpl, env: {} }), true);
  assert.equal(keychainEntryExists(API_KEY_ENTRY, { platform: "linux", spawnImpl, env: {} }), true);
  assert.equal(
    keychainEntryExists(API_KEY_ENTRY, { platform: "darwin", spawnImpl: () => ({ status: 44 }), env: {} }),
    false
  );

  assert.deepEqual(calls[0], {
    command: "security",
    args: ["find-generic-password", "-s", "gemini-cli-api-key", "-a", "default-api-key"]
  });
  assert.deepEqual(calls[1], {
    command: "secret-tool",
    args: ["search", "service", "gemini-cli-api-key", "account", "default-api-key"]
  });
  // `security -w` and `secret-tool lookup` both print the credential. Neither
  // may appear: this check needs presence, and the value is not its business.
  assert.ok(!calls[0].args.includes("-w"));
  assert.ok(!calls[1].args.includes("lookup"));
});

test("the probe fails closed for every way it can go wrong", (t) => {
  t.after(() => resetKeychainProbeCacheForTesting());

  const cases = {
    "tool not installed": { platform: "linux", spawnImpl: () => ({ error: new Error("ENOENT") }) },
    "probe timed out": { platform: "darwin", spawnImpl: () => ({ signal: "SIGTERM" }) },
    "spawn threw": { platform: "darwin", spawnImpl: () => { throw new Error("EACCES"); } },
    "unsupported platform": { platform: "aix", spawnImpl: () => ({ status: 0 }) },
    "opted out": {
      platform: "win32",
      spawnImpl: () => ({ status: 0, stdout: WIN_HIT }),
      env: { GEMINI_COMPANION_DISABLE_KEYCHAIN: "true" }
    }
  };

  for (const [label, options] of Object.entries(cases)) {
    assert.equal(
      keychainEntryExists(API_KEY_ENTRY, { env: {}, ...options }),
      false,
      `${label} must not read as authenticated`
    );
  }
});

test("hasGeminiCredentials accepts a keychain entry with no env key and no OAuth file", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-auth-kc-"));
  const prevHome = process.env.GEMINI_HOME;
  const prevKey = process.env.GEMINI_API_KEY;
  const prevGoogleKey = process.env.GOOGLE_API_KEY;
  process.env.GEMINI_HOME = dir; // no oauth_creds.json here
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  resetKeychainProbeCacheForTesting();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = prevHome;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevKey;
    if (prevGoogleKey === undefined) delete process.env.GOOGLE_API_KEY; else process.env.GOOGLE_API_KEY = prevGoogleKey;
    resetKeychainProbeCacheForTesting();
  });

  let probes = 0;
  const options = {
    platform: "darwin",
    env: {},
    spawnImpl: () => {
      probes += 1;
      return { status: 0 };
    }
  };

  assert.equal(hasGeminiCredentials(options), true);
  assert.equal(probes, 1, "the first entry hits, so the second is never probed");

  // Cached for the life of the process: auto routing asks on every command and
  // the keychain does not change mid-run.
  assert.equal(hasGeminiCredentials(options), true);
  assert.equal(probes, 1);

  // The opt-out is honored after a cached hit. Checking it only inside the
  // probe would let the cache answer for it and silently ignore the setting.
  assert.equal(
    hasGeminiCredentials({ ...options, env: { GEMINI_COMPANION_DISABLE_KEYCHAIN: "1" } }),
    false
  );
});
