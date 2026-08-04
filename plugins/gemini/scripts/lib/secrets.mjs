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
// git quotes whole paths containing special characters — `"a/we ird.env"
// "b/we ird.env"` — so the opening quote sits *before* the `b/`. Match the b/
// side with optional quotes on either end rather than parsing the whole header
// grammar.
export function redactSecretsFromDiff(diff) {
  const text = String(diff ?? "");
  if (!text.trim()) return { text, redactedFiles: [] };

  const parts = text.split(/(?=^diff --git )/m);
  const redactedFiles = [];

  const out = parts.map((part) => {
    if (!part.startsWith("diff --git ")) return part;
    const header = part.slice(0, part.indexOf("\n") === -1 ? part.length : part.indexOf("\n"));
    const match = header.match(/ "?b\/(.+?)"?$/);
    const filePath = match ? match[1] : null;
    if (!filePath || !isSecretFile(filePath)) return part;
    redactedFiles.push(filePath);
    return `${header}\n${SECRET_DIFF_PLACEHOLDER}\n`;
  });

  return { text: out.join(""), redactedFiles };
}
