export function parseArgs(argv, config = {}) {
  const valueOptions = new Set(config.valueOptions ?? []);
  const booleanOptions = new Set(config.booleanOptions ?? []);
  const aliasMap = config.aliasMap ?? {};
  const options = {};
  const positionals = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (passthrough) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const [rawKey, inlineValue] = token.slice(2).split("=", 2);
      const key = aliasMap[rawKey] ?? rawKey;

      if (booleanOptions.has(key)) {
        options[key] = inlineValue === undefined ? true : inlineValue !== "false";
        continue;
      }

      if (valueOptions.has(key)) {
        const nextValue = inlineValue ?? argv[index + 1];
        if (nextValue === undefined) {
          throw new Error(`Missing value for --${rawKey}`);
        }
        options[key] = nextValue;
        if (inlineValue === undefined) {
          index += 1;
        }
        continue;
      }

      positionals.push(token);
      continue;
    }

    const shortKey = token.slice(1);
    const key = aliasMap[shortKey] ?? shortKey;

    if (booleanOptions.has(key)) {
      options[key] = true;
      continue;
    }

    if (valueOptions.has(key)) {
      const nextValue = argv[index + 1];
      if (nextValue === undefined) {
        throw new Error(`Missing value for -${shortKey}`);
      }
      options[key] = nextValue;
      index += 1;
      continue;
    }

    positionals.push(token);
  }

  return { options, positionals };
}

// A slash command expands `$ARGUMENTS` into one shell word, so a whole flag
// string can arrive as a single argv element. Splitting that is what makes
// `/gemini:review --base X` work at all.
//
// The single-element case is not the only one: several commands pass a flag of
// their own *beside* the expansion — `review --background "$ARGUMENTS"`,
// `setup --json "$ARGUMENTS"` — so argv has two elements and the flags inside
// the second were silently discarded. `--base HEAD~1 --scope branch` became one
// positional that review does not accept, and the review reported "nothing to
// review" in a second while a 26-file diff sat unread; `setup --json` reported
// on the engine from the environment rather than the requested one.
//
// A token that starts with a dash *and* contains whitespace cannot be a single
// flag, so it is treated as a nested flag string wherever it appears. Free-text
// positionals (a task prompt, a review focus) do not start with a dash and are
// left alone; text that genuinely does can be protected with `--`, whose
// passthrough is honoured here as well as in parseArgs.
function isNestedFlagString(token) {
  if (typeof token !== "string") return false;
  const trimmed = token.trim();
  return trimmed.startsWith("-") && /\s/.test(trimmed);
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }

  const normalized = [];
  let passthrough = false;
  for (const token of argv) {
    if (passthrough) {
      normalized.push(token);
      continue;
    }
    if (token === "--") {
      passthrough = true;
      normalized.push(token);
      continue;
    }
    if (isNestedFlagString(token)) {
      normalized.push(...splitRawArgumentString(token));
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}

export function splitRawArgumentString(raw) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === "\"") {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += character;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
