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
  /^\.netrc$/i,
  /credentials\.json$/i,
  /_creds\.json$/i,
  /secrets?\.(json|yml|yaml|env)$/i,
  /^(?!.*\.pub$)id_(?:rsa|ed25519|ecdsa|dsa)(?:$|[._-])/i,
];

export function decodeGitQuotedPath(raw) {
  const value = String(raw ?? "").trim();
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }
  const unquoted = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < unquoted.length; i += 1) {
    if (unquoted[i] !== "\\" || i + 1 >= unquoted.length) {
      const cp = unquoted.codePointAt(i);
      const encoded = Buffer.from(String.fromCodePoint(cp), "utf8");
      for (const byte of encoded) bytes.push(byte);
      if (cp > 0xffff) i += 1;
      continue;
    }
    const next = unquoted[i + 1];
    if (/^[0-7]{3}$/.test(unquoted.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(unquoted.slice(i + 1, i + 4), 8));
      i += 3;
      continue;
    }
    const escapes = {
      "\\": 0x5c,
      '"': 0x22,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b
    };
    if (escapes[next] !== undefined) {
      bytes.push(escapes[next]);
      i += 1;
      continue;
    }
    const encoded = Buffer.from(unquoted[i], "utf8");
    for (const byte of encoded) bytes.push(byte);
  }
  return Buffer.from(bytes).toString("utf8");
}

export function isSecretFile(filepath) {
  // Only Git C-quoted inputs ("...") undergo Git escape decoding; raw filesystem
  // paths keep native separator/basename semantics.
  const trimmed = String(filepath ?? "").trim();
  const decoded = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? decodeGitQuotedPath(trimmed)
    : trimmed;
  const filename = decoded.split(/[\\/]/).pop() ?? "";
  return SECRET_PATTERNS.some((pattern) => pattern.test(filename));
}

export const SECRET_DIFF_PLACEHOLDER = "[REDACTED: secret file content withheld from the model]";

function extractGitSidePath(rawTarget, sidePrefix) {
  const trimmed = String(rawTarget ?? "").trim();
  if (!trimmed) return { displayPath: null, matchPath: null };
  const isQuoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
  if (isQuoted) {
    const inner = trimmed.slice(1, -1);
    const unprefixed = inner.startsWith(sidePrefix) ? inner.slice(sidePrefix.length) : inner;
    const decoded = decodeGitQuotedPath(`"${unprefixed}"`);
    return { displayPath: unprefixed, matchPath: decoded };
  }
  const unprefixed = trimmed.startsWith(sidePrefix) ? trimmed.slice(sidePrefix.length) : trimmed;
  return { displayPath: unprefixed, matchPath: unprefixed };
}

function bSideInfo(part, header) {
  for (const line of part.split("\n")) {
    if (line.startsWith("@@")) break;
    if (!line.startsWith("+++ ")) continue;
    const target = line.slice(4).trim();
    if (target === "/dev/null") break;
    return extractGitSidePath(target, "b/");
  }

  const renamed = part.match(/^(?:rename|copy) to (.+)$/m);
  if (renamed) return extractGitSidePath(renamed[1], "");

  const match = header.match(/ ("?b\/.+?"?)$/);
  if (!match) return { displayPath: null, matchPath: null };
  return extractGitSidePath(match[1], "b/");
}

function aSideInfo(part, header) {
  for (const line of part.split("\n")) {
    if (line.startsWith("@@")) break;
    if (!line.startsWith("--- ")) continue;
    const target = line.slice(4).trim();
    if (target === "/dev/null") break;
    return extractGitSidePath(target, "a/");
  }

  const renamed = part.match(/^(?:rename|copy) from (.+)$/m);
  if (renamed) return extractGitSidePath(renamed[1], "");

  const match = header.match(/^diff --git ("?a\/.+?"?) ("?b\/.+?"?)$/);
  if (!match) return { displayPath: null, matchPath: null };
  return extractGitSidePath(match[1], "a/");
}

export function splitDiffByFile(diff) {
  const text = String(diff ?? "");
  if (!text.trim()) return [];

  return text.split(/(?=^diff --git )/m).map((part) => {
    if (!part.startsWith("diff --git ")) {
      return { path: null, matchPath: null, aPath: null, aMatchPath: null, header: null, text: part };
    }
    const newline = part.indexOf("\n");
    const header = part.slice(0, newline === -1 ? part.length : newline);
    const bSide = bSideInfo(part, header);
    const aSide = aSideInfo(part, header);
    return {
      path: bSide.displayPath,
      matchPath: bSide.matchPath,
      aPath: aSide.displayPath,
      aMatchPath: aSide.matchPath,
      header,
      text: part
    };
  });
}

export function redactSecretsFromDiff(diff) {
  const text = String(diff ?? "");
  if (!text.trim()) return { text, redactedFiles: [] };

  const redactedFiles = [];
  const out = splitDiffByFile(text).map((part) => {
    const bMatched = (part.matchPath && isSecretFile(part.matchPath)) || (part.path && isSecretFile(part.path));
    const aMatched = (part.aMatchPath && isSecretFile(part.aMatchPath)) || (part.aPath && isSecretFile(part.aPath));
    const matched = bMatched ? part.path : (aMatched ? part.aPath : null);
    if (!matched) return part.text;
    redactedFiles.push(matched);
    return `${part.header}\n${SECRET_DIFF_PLACEHOLDER}\n`;
  });

  return { text: out.join(""), redactedFiles };
}
