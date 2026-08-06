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

// Real headers produced by git for these names, captured from a repository
// built with each file in it. A directory containing a space puts a second
// ` b/` inside the header.
test("redactSecretsFromDiff names the right file when the path contains ' b/'", () => {
  const diff = [
    "diff --git a/a b/c.env b/a b/c.env",
    "--- a/a b/c.env",
    "+++ b/a b/c.env",
    "@@ -1 +1 @@",
    "+SECRET=SPACED_DIR_LEAK",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.ok(!text.includes("SPACED_DIR_LEAK"));
  assert.deepEqual(redactedFiles, ["a b/c.env"]);
});

test("redactSecretsFromDiff reports the b-side path of a rename", () => {
  const diff = ["diff --git a/settings.js b/config/prod.env", "+API_KEY=RENAMED_LEAK", ""].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.ok(!text.includes("RENAMED_LEAK"), "the destination decides, and it is a secret store");
  assert.deepEqual(redactedFiles, ["config/prod.env"]);
});

// git applies C-style quoting to non-ASCII paths under the default
// core.quotepath. Redaction still fires because the escaped form keeps the
// extension; the reported name stays in git's escaped form rather than being
// unquoted, which is a display limit and not a leak.
test("redactSecretsFromDiff still redacts a git-escaped non-ASCII path", () => {
  const diff = [
    'diff --git "a/uni\\303\\247ode.env" "b/uni\\303\\247ode.env"',
    "+SECRET=UNICODE_LEAK",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.ok(!text.includes("UNICODE_LEAK"));
  assert.deepEqual(redactedFiles, ["uni\\303\\247ode.env"]);
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

// Deleting a credential file is the case the `+++ /dev/null` branch exists for:
// the b-side names no file, so the path has to come from the header instead.
// The removed contents are still contents — a deletion diff carries every line
// of the secret with a `-` in front of it.
test("redactSecretsFromDiff withholds the body of a deleted secret file", () => {
  const diff = [
    "diff --git a/config/.env b/config/.env",
    "deleted file mode 100644",
    "index 1234567..0000000",
    "--- a/config/.env",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-API_TOKEN=DELETED_SECRET_LEAK",
    "-DB_PASSWORD=hunter2",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.ok(!text.includes("DELETED_SECRET_LEAK"), "the deleted secret's value survived redaction");
  assert.ok(!text.includes("hunter2"));
  assert.deepEqual(redactedFiles, ["config/.env"]);
  assert.ok(text.startsWith("diff --git a/config/.env b/config/.env"), "the header must survive so the review knows the file changed");
});

// The same branch, but for an ordinary file: falling back to the header must not
// start redacting things that are not secrets.
test("a deleted ordinary file is left alone", () => {
  const diff = [
    "diff --git a/src/old.js b/src/old.js",
    "deleted file mode 100644",
    "--- a/src/old.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-export const gone = true;",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.equal(text, diff);
  assert.deepEqual(redactedFiles, []);
});

// Not covered here: a newly added secret file. Its `--- /dev/null` sits on the
// a-side, which bSidePath never reads, so it takes the identical path to the
// ordinary case above and would assert nothing the first test does not.
