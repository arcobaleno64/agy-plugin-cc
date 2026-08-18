import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EFFORT_MODEL_MAP,
  MODEL_ALIASES,
  MODEL_ALIAS_ENTRIES,
  MODEL_MAP_METADATA
} from "../plugins/gemini/scripts/lib/model-map.mjs";
import {
  mapEffortToModel,
  normalizeRequestedModel,
  VALID_EFFORT_LEVELS
} from "../plugins/gemini/scripts/lib/engine.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("model aliases resolve to their canonical model id", () => {
  assert.equal(normalizeRequestedModel("flash"), "gemini-3-flash-preview");
  assert.equal(normalizeRequestedModel("pro"), "gemini-3.1-pro-preview");
  // Alias lookup is case-insensitive.
  assert.equal(normalizeRequestedModel("LITE"), "gemini-2.5-flash-lite");
  for (const { alias, model } of MODEL_ALIAS_ENTRIES) {
    assert.equal(normalizeRequestedModel(alias), model);
  }
});

test("effort tiers map to a model and define the valid set", () => {
  assert.equal(mapEffortToModel("low"), "gemini-3-flash-preview");
  assert.equal(mapEffortToModel("high"), "gemini-3.1-pro-preview");
  assert.equal(mapEffortToModel("none"), "gemini-2.5-flash-lite");
  assert.equal(mapEffortToModel(null), null);
  assert.equal(mapEffortToModel("bogus"), null);
  assert.deepEqual([...VALID_EFFORT_LEVELS].sort(), [...EFFORT_MODEL_MAP.keys()].sort());
});

test("an unknown alias passes through unchanged (trimmed)", () => {
  assert.equal(normalizeRequestedModel("gemini-9.9-experimental"), "gemini-9.9-experimental");
  assert.equal(normalizeRequestedModel("  custom-model  "), "custom-model");
  assert.equal(normalizeRequestedModel(null), null);
  assert.equal(normalizeRequestedModel(""), null);
});

test("preview entries are flagged and metadata records provenance", () => {
  const preview = MODEL_ALIAS_ENTRIES.filter((entry) => entry.preview);
  assert.ok(preview.every((entry) => entry.model.includes("preview")));
  assert.ok(MODEL_MAP_METADATA.lastVerified, "metadata must record lastVerified");
  assert.ok(MODEL_MAP_METADATA.source, "metadata must record a source");
});

function parseReadmeAliasTable(readme) {
  const afterHeading = readme.split(/^##\s+Model Aliases\s*$/m)[1];
  assert.ok(afterHeading, "README.md must have a `## Model Aliases` section");
  const body = afterHeading.split(/^---\s*$/m)[0];
  const map = new Map();
  for (const line of body.split(/\r?\n/)) {
    if (!/^\|\s*`/.test(line)) {
      continue; // only table rows that begin with a backticked alias
    }
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) {
      continue;
    }
    const aliases = [...cells[0].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const models = [...cells[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    if (!aliases.length || models.length !== 1) {
      continue;
    }
    for (const alias of aliases) {
      map.set(alias, models[0]);
    }
  }
  return map;
}

test("README model alias table matches model-map.mjs exactly", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const readmeMap = parseReadmeAliasTable(readme);

  for (const [alias, model] of MODEL_ALIASES) {
    assert.equal(readmeMap.get(alias), model, `README missing or mismatched alias \`${alias}\``);
  }
  for (const [alias, model] of readmeMap) {
    assert.equal(MODEL_ALIASES.get(alias), model, `README declares unknown alias \`${alias}\``);
  }
});

// ---------------------------------------------------------------------------
// model-map.mjs used to carry a copy of `agy models` output as a comment, dated
// to AGY 1.1.10. By 1.1.13 the real listing had gained three ids it did not
// mention. No code read the list — normalizeAgyRequestedModel validates the
// character set and rejects Gemini aliases, and never compares against a roster
// — so it was a copy that could only ever drift, with nothing able to notice.
//
// It cannot be kept honest automatically either: `agy models` on 1.1.13 offers
// only -h/--help, so there is no machine-readable form to diff a copy against,
// and the probe needs AGY installed, which CI does not have. So the rule is that
// the copy does not come back. One id may stay as an illustration of the shape
// (AGY encodes the effort tier into the id); several are a roster again.
// ---------------------------------------------------------------------------

const AGY_ID_SHAPE = /gemini-\d[\d.]*-[a-z]+-(?:high|medium|low)\b/g;

test("model-map does not keep its own copy of AGY's model listing", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "plugins", "gemini", "scripts", "lib", "model-map.mjs"),
    "utf8"
  );
  const ids = [...new Set(source.match(AGY_ID_SHAPE) ?? [])];
  assert.ok(
    ids.length <= 1,
    `model-map.mjs names ${ids.length} AGY model ids (${ids.join(", ")}). ` +
      "One illustrates the id shape; a list is a roster that will drift. " +
      "Dated readings belong in docs/MODEL_COMPARISON.md §D."
  );
});

test("the document model-map sends readers to for the listing exists", () => {
  const source = fs.readFileSync(
    path.join(ROOT, "plugins", "gemini", "scripts", "lib", "model-map.mjs"),
    "utf8"
  );
  const referenced = source.match(/docs\/[A-Za-z0-9_.-]+\.md/g) ?? [];
  assert.ok(referenced.length > 0, "model-map points nowhere for the AGY listing");
  for (const relPath of new Set(referenced)) {
    assert.ok(
      fs.existsSync(path.join(ROOT, relPath)),
      `model-map.mjs points at ${relPath}, which does not exist`
    );
  }
});

// The dated readings have to actually be there, or the pointer above sends a
// reader to a document that answers a different question.
test("MODEL_COMPARISON records a dated AGY model listing", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs", "MODEL_COMPARISON.md"), "utf8");
  assert.match(doc, /`agy models`/, "no reading of the AGY listing is recorded");
  assert.ok(
    (doc.match(AGY_ID_SHAPE) ?? []).length >= 3,
    "the recorded listing names too few ids to be a listing"
  );
});
