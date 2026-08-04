import test from "node:test";
import assert from "node:assert/strict";

import { isSecretFile, redactSecretsFromDiff, SECRET_DIFF_PLACEHOLDER } from "../plugins/gemini/scripts/lib/secrets.mjs";

test("isSecretFile matches on the basename, including nested paths", () => {
  assert.equal(isSecretFile(".env"), true);
  assert.equal(isSecretFile("config/.env.production"), true);
  assert.equal(isSecretFile("deep/nested/dir/id_rsa"), true);
  assert.equal(isSecretFile("certs\\server.key"), true, "Windows separators must resolve too");
  // The original pattern was anchored at `^\.env`, so a store named for its
  // stage was missed entirely.
  assert.equal(isSecretFile("prod.env"), true);
  assert.equal(isSecretFile("config/staging.env"), true);
  assert.equal(isSecretFile("src/index.js"), false);
  assert.equal(isSecretFile("docs/environment.md"), false, "'environment' must not match the .env pattern");
  assert.equal(isSecretFile(""), false);
  assert.equal(isSecretFile(null), false);
});

test("redactSecretsFromDiff withholds secret file bodies and keeps the rest", () => {
  const diff = [
    "diff --git a/src/app.js b/src/app.js",
    "index 111..222 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1 +1 @@",
    "-const a = 1;",
    "+const a = 2;",
    "diff --git a/.env b/.env",
    "index 333..444 100644",
    "--- a/.env",
    "+++ b/.env",
    "@@ -1 +1 @@",
    "-API_KEY=old",
    "+API_KEY=LEAKED_VALUE",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);

  assert.ok(!text.includes("LEAKED_VALUE"), "secret content must not survive");
  assert.ok(text.includes(SECRET_DIFF_PLACEHOLDER));
  assert.ok(text.includes("const a = 2;"), "ordinary code must survive");
  // The header stays so the review still knows the file changed.
  assert.ok(text.includes("diff --git a/.env b/.env"));
  assert.deepEqual(redactedFiles, [".env"]);
});

test("redactSecretsFromDiff handles git's quoted paths", () => {
  const diff = [
    'diff --git "a/we ird.env" "b/we ird.env"',
    "--- a/we ird.env",
    "+++ b/we ird.env",
    "@@ -1 +1 @@",
    "+SECRET=QUOTED_LEAK",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.ok(!text.includes("QUOTED_LEAK"));
  assert.deepEqual(redactedFiles, ["we ird.env"]);
});

test("redactSecretsFromDiff passes through a diff with nothing to redact", () => {
  const diff = "diff --git a/a.js b/a.js\n+const a = 1;\n";
  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.equal(text, diff);
  assert.deepEqual(redactedFiles, []);
});

test("redactSecretsFromDiff tolerates empty and nullish input", () => {
  for (const input of ["", "   ", null, undefined]) {
    const { redactedFiles } = redactSecretsFromDiff(input);
    assert.deepEqual(redactedFiles, []);
  }
});
