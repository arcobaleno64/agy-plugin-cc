import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// Gemini credential inspection, kept in its own module so engine.mjs can consult
// it without importing gemini.mjs (which imports engine.mjs). gemini.mjs
// re-exports these for existing callers.

function geminiHomeDir() {
  return process.env.GEMINI_HOME ?? path.join(os.homedir(), ".gemini");
}

export function getGeminiLoginStatus() {
  const credFile = path.join(geminiHomeDir(), "oauth_creds.json");
  if (!fs.existsSync(credFile)) {
    return { loggedIn: false, detail: `No credentials at ${credFile}. Run \`gemini\` to authenticate.` };
  }
  try {
    const creds = JSON.parse(fs.readFileSync(credFile, "utf8"));
    const expiry = creds?.expiry_date ?? creds?.expiry ?? creds?.token?.expiry_date;
    if (expiry && Date.now() > Number(expiry)) {
      return { loggedIn: false, detail: `OAuth token expired at ${new Date(Number(expiry)).toISOString()}. Run \`gemini\` to re-authenticate.` };
    }
  } catch {
    return { loggedIn: false, detail: `Cannot read credentials at ${credFile}. Run \`gemini\` to authenticate.` };
  }
  return { loggedIn: true, detail: `OAuth credentials found at ${credFile}` };
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

// Whether the gemini CLI has any credential it could actually use. An API key
// bypasses the OAuth file entirely, so check it first — an API-key user has no
// oauth_creds.json and must not be treated as unauthenticated.
//
// This is the same notion `/gemini:setup` calls `geminiReady`: installed AND
// authenticated. Auto-routing consults it so it cannot select a gemini binary
// that answers `--version` but rejects every request.
export function hasGeminiCredentials() {
  if (String(process.env.GEMINI_API_KEY ?? "").trim() || String(process.env.GOOGLE_API_KEY ?? "").trim()) {
    return true;
  }
  return getGeminiLoginStatus().loggedIn;
}
