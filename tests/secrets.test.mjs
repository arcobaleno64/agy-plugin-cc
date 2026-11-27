import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { decodeGitQuotedPath, isSecretFile, redactSecretsFromDiff, SECRET_DIFF_PLACEHOLDER } from "../plugins/gemini/scripts/lib/secrets.mjs";
import { formatUntrackedFile } from "../plugins/gemini/scripts/lib/git.mjs";
import { initGitRepo } from "./helpers.mjs";

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

test("decodeGitQuotedPath decodes each C-escape sequence cleanly without decoding unquoted paths", () => {
  assert.equal(decodeGitQuotedPath('"a\\a"'), "a\x07");
  assert.equal(decodeGitQuotedPath('"b\\b"'), "b\x08");
  assert.equal(decodeGitQuotedPath('"f\\f"'), "f\x0c");
  assert.equal(decodeGitQuotedPath('"v\\v"'), "v\x0b");
  assert.equal(decodeGitQuotedPath('"t\\t\\n\\r"'), "t\t\n\r");
  assert.equal(decodeGitQuotedPath('"q\\\\\\"\\056env"'), 'q\\".env');
  assert.equal(decodeGitQuotedPath('"dir/\\t🔑\\056env"'), "dir/\t🔑.env");
  assert.equal(decodeGitQuotedPath("plain\\056txt"), "plain\\056txt");
});

test("isSecretFile covers .netrc, SSH private keys, quoted C-escapes, and avoids unquoted escape mangling or public keys", () => {
  for (const file of [".netrc", "home/user/.netrc", "keys/id_rsa", "id_rsa.bak", "id_rsa.old", "keys/id_rsa_work", "keys/id_ed25519", "keys/id_ed25519.bak", "keys/id_ecdsa", "keys/id_dsa", "keys/id_ed25519.key", '"dir/secret\\303\\247.env"', '"dir/\\a\\b\\f\\v\\056env"', '"dir/\\t🔑\\056env"']) {
    assert.equal(isSecretFile(file), true, `${file} must match`);
  }
  for (const file of ["keys/id_ed25519.pub", "keys/id_rsa.pub", "keys/id_rsa_work.pub", "src/my_id_dsa_helper.js", "C:\\temp\\notes.txt", "plain\\056txt"]) {
    assert.equal(isSecretFile(file), false, `${file} must NOT match`);
  }
});

test("redactSecretsFromDiff catches copy-to secrets, private key backups, and decoded C-quoted filenames", () => {
  const backupDiff = [
    "diff --git a/id_rsa.bak b/id_rsa.bak",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/id_rsa.bak",
    "@@ -0,0 +1 @@",
    "+-----BEGIN OPENSSH PRIVATE KEY-----",
    "diff --git a/id_rsa.old b/id_rsa.old",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/id_rsa.old",
    "@@ -0,0 +1 @@",
    "+-----BEGIN RSA PRIVATE KEY-----",
    ""
  ].join("\n");
  const redactedBackups = redactSecretsFromDiff(backupDiff);
  assert.ok(!redactedBackups.text.includes("PRIVATE KEY"));
  assert.deepEqual(redactedBackups.redactedFiles, ["id_rsa.bak", "id_rsa.old"]);
  const copyDiff = [
    "diff --git a/template.txt b/keys/id_ed25519",
    "similarity index 100%",
    "copy from template.txt",
    "copy to keys/id_ed25519",
    "+PRIVATE_KEY_BODY",
    ""
  ].join("\n");
  const copied = redactSecretsFromDiff(copyDiff);
  assert.ok(!copied.text.includes("PRIVATE_KEY_BODY"));
  assert.deepEqual(copied.redactedFiles, ["keys/id_ed25519"]);

  const cQuotedDiff = [
    'diff --git "a/dir/\\056env" "b/dir/notes.txt"',
    "rename from \"dir/\\056env\"",
    "rename to dir/notes.txt",
    "-SECRET=OCTAL_ESCAPED",
    ""
  ].join("\n");
  const decoded = redactSecretsFromDiff(cQuotedDiff);
  assert.ok(!decoded.text.includes("OCTAL_ESCAPED"));
});

test("formatUntrackedFile skips files exceeding MAX_UNTRACKED_BYTES", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-size-"));
  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, "big.txt"), "A".repeat(25 * 1024), "utf8");
    const formatted = formatUntrackedFile(repo, "big.txt");
    assert.match(formatted, /exceeds 24576 byte limit/);
    assert.ok(!formatted.includes("AAAA"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("redactSecretsFromDiff withholds the body when a secret file is renamed to an ordinary path", () => {
  const diff = [
    "diff --git a/.env b/notes.txt",
    "similarity index 90%",
    "rename from .env",
    "rename to notes.txt",
    "--- a/.env",
    "+++ b/notes.txt",
    "@@ -1,2 +1,2 @@",
    "-API_TOKEN=RENAMED_SECRET_VALUE",
    "+API_TOKEN=RENAMED_SECRET_VALUE_NEW",
    ""
  ].join("\n");

  const { text, redactedFiles } = redactSecretsFromDiff(diff);
  assert.ok(!text.includes("RENAMED_SECRET_VALUE"), "a-side secret content must be redacted");
  assert.deepEqual(redactedFiles, [".env"]);
});

test("formatUntrackedFile redacts an in-repo symlink targeting a secret file", (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-link-"));
  try {
    initGitRepo(repo);
    fs.writeFileSync(path.join(repo, ".env"), "TOP_SECRET=123\n", "utf8");
    const linkPath = path.join(repo, "notes.txt");
    try {
      fs.symlinkSync(path.join(repo, ".env"), linkPath, "file");
    } catch {
      t.skip("file symlinks require elevated privilege on this host");
      return;
    }
    const formatted = formatUntrackedFile(repo, "notes.txt");
    assert.ok(!formatted.includes("TOP_SECRET=123"));
    assert.ok(formatted.includes(SECRET_DIFF_PLACEHOLDER));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
