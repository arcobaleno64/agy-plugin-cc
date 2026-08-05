// Secret-file detection, shared by every path that sends repository content to a
// model. transfer-context.mjs re-exports isSecretFile under its existing name.
//
// Filename-based only: a credential pasted into an ordinary source file is not
// detected here and never has been. This catches the files that exist to hold
// secrets, which is where they usually are.

const SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,
  // The anchored pattern above only covers `.env` and `.env.production`. A file
  // named `prod.env` or `staging.env` is the same kind of store and was missed.
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.(p12|pfx|crt|keystore)$/i,
  /^\.npmrc$/i,
  /credentials\.json$/i,
  /_creds\.json$/i,
  /secrets?\.(json|yml|yaml|env)$/i,
  /id_rsa/i,
];

export function isSecretFile(filepath) {
  const filename = String(filepath ?? "").split(/[\\/]/).pop() ?? "";
  return SECRET_PATTERNS.some((pattern) => pattern.test(filename));
}

export const SECRET_DIFF_PLACEHOLDER = "[REDACTED: secret file content withheld from the model]";

// Split a unified diff on its `diff --git a/x b/y` boundaries and withhold the
// body of any file that looks like a secret store, keeping the header so the
// review still knows the file changed.
//
// The `diff --git a/<P> b/<P>` header is genuinely ambiguous once a path holds a
// space: for `a b/c.env` git emits `diff --git a/a b/c.env b/a b/c.env`, and no
// regex over that line alone can say where the a-side ends — the first ` b/`
// yields `c.env b/a b/c.env`, the last yields `c.env`, and both are wrong. git's
// own tooling resolves it from the `+++ b/<path>` line, which runs to end of
// line and cannot be misread. Use that, and keep the header regex for the cases
// that have no `+++` line at all (pure renames, mode changes).
//
// git quotes whole paths containing special characters — `"b/we ird.env"` — so
// the opening quote sits *before* the `b/` on every form. Strip optional quotes
// on both ends rather than parsing git's C-quoting grammar; the escaped name is
// reported as git wrote it.
function bSidePath(part, header) {
  for (const line of part.split("\n")) {
    // Stop at the first hunk: an added line whose content begins with `++ `
    // renders as `+++ ...` and would otherwise be read as the file header.
    if (line.startsWith("@@")) break;
    if (!line.startsWith("+++ ")) continue;
    const target = line.slice(4).trim();
    if (target === "/dev/null") break; // deletion: fall back to the header
    const unquoted = target.replace(/^"(.*)"$/, "$1");
    return unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
  }

  const renamed = part.match(/^rename to (.+)$/m);
  if (renamed) return renamed[1].trim().replace(/^"(.*)"$/, "$1");

  // Last resort. The capture runs to end of line, so its final path segment is
  // still the real basename even when the prefix is wrong — which is what
  // isSecretFile tests.
  const match = header.match(/ "?b\/(.+?)"?$/);
  return match ? match[1] : null;
}

export function redactSecretsFromDiff(diff) {
  const text = String(diff ?? "");
  if (!text.trim()) return { text, redactedFiles: [] };

  const parts = text.split(/(?=^diff --git )/m);
  const redactedFiles = [];

  const out = parts.map((part) => {
    if (!part.startsWith("diff --git ")) return part;
    const header = part.slice(0, part.indexOf("\n") === -1 ? part.length : part.indexOf("\n"));
    const filePath = bSidePath(part, header);
    if (!filePath || !isSecretFile(filePath)) return part;
    redactedFiles.push(filePath);
    return `${header}\n${SECRET_DIFF_PLACEHOLDER}\n`;
  });

  return { text: out.join(""), redactedFiles };
}
