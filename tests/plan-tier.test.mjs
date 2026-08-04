import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getGeminiPlanTier } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { hasGeminiCredentials } from "../plugins/gemini/scripts/lib/gemini-auth.mjs";

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

  delete process.env.GEMINI_API_KEY;
  assert.equal(hasGeminiCredentials(), false);

  process.env.GEMINI_API_KEY = "  ";
  assert.equal(hasGeminiCredentials(), false, "whitespace is not a credential");

  process.env.GEMINI_API_KEY = "AIza-test-key";
  assert.equal(hasGeminiCredentials(), true);
});
