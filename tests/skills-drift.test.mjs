import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MODEL_ALIASES,
  MODEL_ALIAS_ENTRIES
} from "../plugins/gemini/scripts/lib/model-map.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The changelog (plugins/gemini/CHANGELOG.md) is excluded by using a directory
// allowlist rather than an exclusion list because it is a historical record
// that legitimately quotes removed wording verbatim.
const ALLOWLIST_DIRS = [
  "plugins/gemini/agents",
  "plugins/gemini/commands",
  "plugins/gemini/skills",
  "plugins/gemini/prompts"
];

function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

const SCANNED_FILES = ALLOWLIST_DIRS.flatMap((relDir) =>
  collectMarkdownFiles(path.join(ROOT, relDir))
);

function toRelPath(absolutePath) {
  return path.relative(ROOT, absolutePath).replace(/\\/g, "/");
}

const sentences = (line) => line.split(/(?<=[.!?])\s+(?=[A-Z`(\-*])/);

// Protects: when the user did not ask for edits, gemini:gemini-rescue does not
// write their repository. plugins/gemini/agents/gemini-rescue.md:34 is the authority;
// write-by-default was removed in plugin v0.16.0 and docs/THREAT-MODEL.md §7.2
// records that an AGY --write run has no path boundary.
//
// Note: This pattern is narrower than searching for "--write" near "default" because
// corrected sentences legitimately say "read-only mode by default, and add --write
// only when the user explicitly asked for edits", and a looser pattern flags them.
test("rule 1: no instruction may say a write-capable run is the default", () => {
  const rule1Pattern =
    /(write[- ](capable|mode)[^.]{0,60}by default)|(\bdefaults? to (a )?(write|--write|write-capable|write mode))|(\bdefault is (a )?(write|--write|write-capable|write mode))/i;

  for (const filePath of SCANNED_FILES) {
    const relPath = toRelPath(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, lineIdx) => {
      const lineNum = lineIdx + 1;
      for (const sentence of sentences(line)) {
        assert.equal(
          rule1Pattern.test(sentence),
          false,
          `${relPath}:${lineNum}: "${sentence}"`
        );
      }
    });
  }
});

// Protects: the docs do not teach users to abandon a feature that works. False
// since AGY 1.1.10; buildCliArgs in plugins/gemini/scripts/lib/engine.mjs pushes
// both flags to the AGY command.
//
// Note: All three conditions must be in the same sentence. For instance,
// plugins/gemini/commands/setup.md:27 says "read as one positional and ignored"
// about --json, and a looser rule flags it.
test("rule 2: no instruction may claim AGY ignores --model / --effort", () => {
  const reAgy = /\bagy\b/i;
  const reFlags = /--model|--effort/;
  const reIgnored =
    /\bignored\b|not translated|do not apply|\bunmanaged\b|leaves model choice/i;

  for (const filePath of SCANNED_FILES) {
    const relPath = toRelPath(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, lineIdx) => {
      const lineNum = lineIdx + 1;
      for (const sentence of sentences(line)) {
        const matchesAllThree =
          reAgy.test(sentence) &&
          reFlags.test(sentence) &&
          reIgnored.test(sentence);

        assert.equal(
          matchesAllThree,
          false,
          `${relPath}:${lineNum}: "${sentence}"`
        );
      }
    });
  }
});

// Protects: instructions point at the JSON envelope the plugin actually parses,
// so a subagent does not tell the user to go read transcript files.
//
// Note: Pattern (a) is directional on purpose (/transcript[^.]{0,60}\b(authoritative|source of truth)/i).
// The correct sentence at plugins/gemini/skills/gemini-prompting/references/gemini-prompt-antipatterns.md:130
// contains both "authoritative" and "transcript" in that order ("the plugin reads AGY's stdout JSON
// envelope as authoritative ... while on-disk transcript recovery remains only as the fallback") and
// must pass.
test("rule 3: no instruction may describe AGY's output the pre-v0.11.0 way", () => {
  const reShapeA = /transcript[^.]{0,60}\b(authoritative|source of truth)/i;
  const reShapeB1 = /\bagy\b/i;
  const reShapeB2 =
    /plain text|without structured|no structured|not structured/i;

  for (const filePath of SCANNED_FILES) {
    const relPath = toRelPath(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, lineIdx) => {
      const lineNum = lineIdx + 1;
      for (const sentence of sentences(line)) {
        const matchesShapeA = reShapeA.test(sentence);
        const matchesShapeB =
          reShapeB1.test(sentence) && reShapeB2.test(sentence);

        assert.equal(
          matchesShapeA || matchesShapeB,
          false,
          `${relPath}:${lineNum}: "${sentence}"`
        );
      }
    });
  }
});

// Protects: model aliases in documentation stay in sync with their single source
// of truth (MODEL_ALIASES and MODEL_ALIAS_ENTRIES in model-map.mjs).
//
// Note: Rule 4(b) is the assertion that makes the doc go red when someone adds an
// alias to model-map.mjs without documenting it in SKILL.md.
test("rule 4: model aliases stay in sync with single source of truth", () => {
  const mappingPattern =
    /`([a-z0-9]+)`(?:\s*\/\s*`([a-z0-9]+)`)*\s*(?:→|->)\s*`(gemini-[^`]+)`/g;

  // 4(a) Every alias-to-model mapping written anywhere in the scanned tree must match the map.
  for (const filePath of SCANNED_FILES) {
    const relPath = toRelPath(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    lines.forEach((line, lineIdx) => {
      const lineNum = lineIdx + 1;
      const matches = [...line.matchAll(mappingPattern)];
      for (const match of matches) {
        const tokens = [...match[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        const modelId = tokens.find((t) => t.startsWith("gemini-"));
        const aliases = tokens.filter((t) => !t.startsWith("gemini-"));

        for (const alias of aliases) {
          const expectedModel = MODEL_ALIASES.get(alias);
          assert.equal(
            expectedModel,
            modelId,
            `${relPath}:${lineNum}: alias \`${alias}\` mapped to \`${modelId}\`, but MODEL_ALIASES maps to \`${expectedModel}\``
          );
        }
      }
    });
  }

  // 4(b) Completeness: in plugins/gemini/skills/gemini-cli-runtime/SKILL.md,
  // find the line containing MODEL_ALIAS_ENTRIES and assert it mentions every
  // alias in MODEL_ALIAS_ENTRIES as a backticked token.
  const skillRelPath = "plugins/gemini/skills/gemini-cli-runtime/SKILL.md";
  const skillFullPath = path.join(ROOT, skillRelPath);
  const skillContent = fs.readFileSync(skillFullPath, "utf8");
  const skillLines = skillContent.split(/\r?\n/);

  const targetLineIdx = skillLines.findIndex((line) =>
    line.includes("MODEL_ALIAS_ENTRIES")
  );
  assert.ok(
    targetLineIdx !== -1,
    `${skillRelPath}: expected line containing MODEL_ALIAS_ENTRIES`
  );

  const targetLine = skillLines[targetLineIdx];
  const lineNum = targetLineIdx + 1;
  const backtickedTokens = [...targetLine.matchAll(/`([^`]+)`/g)].map(
    (m) => m[1]
  );

  for (const entry of MODEL_ALIAS_ENTRIES) {
    assert.ok(
      backtickedTokens.includes(entry.alias),
      `${skillRelPath}:${lineNum}: missing alias \`${entry.alias}\` in MODEL_ALIAS_ENTRIES documentation line`
    );
  }
});
