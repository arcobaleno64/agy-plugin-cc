import test from "node:test";
import assert from "node:assert/strict";

import { scoreReview, findingMatchesPlanted, normalizeFile } from "./lib/score.mjs";
import { _internal as adapters } from "./lib/adapters.mjs";
import { buildScorecard } from "./lib/report.mjs";

const TRUTH = {
  planted: [
    {
      id: "sqli",
      category: "injection",
      file: "src/auth.js",
      line_start: 10,
      line_end: 12,
      severity: "critical",
      match: { keywords: ["sql injection", "parameteri"] }
    },
    {
      id: "json-parse",
      category: "error-handling",
      file: "src/auth.js",
      line_start: 40,
      line_end: 41,
      severity: "high",
      match: { keywords: ["json.parse", "unguarded"] }
    }
  ],
  allowed_extras: [
    { id: "jwt-expiry", file: "src/auth.js", match: { keywords: ["expiresin", "no expiry"] } }
  ]
};

function finding(over = {}) {
  return {
    severity: "high",
    title: "x",
    body: "y",
    file: "src/auth.js",
    line_start: 1,
    line_end: 1,
    confidence: 0.9,
    recommendation: "fix",
    ...over
  };
}

test("normalizeFile makes paths comparable across separators and ./ prefixes", () => {
  assert.equal(normalizeFile(".\\src\\Auth.js"), "src/auth.js");
  assert.equal(normalizeFile("./src/auth.js"), "src/auth.js");
});

test("findingMatchesPlanted matches on overlapping line range", () => {
  const f = finding({ line_start: 11, line_end: 11, title: "bug", body: "z" });
  assert.equal(findingMatchesPlanted(f, TRUTH.planted[0]), true);
});

test("findingMatchesPlanted matches on keyword when lines are off", () => {
  const f = finding({ line_start: 200, line_end: 201, title: "SQL injection risk", body: "use parameterized query" });
  assert.equal(findingMatchesPlanted(f, TRUTH.planted[0]), true);
});

test("findingMatchesPlanted rejects a different file", () => {
  const f = finding({ file: "src/other.js", line_start: 11, line_end: 11 });
  assert.equal(findingMatchesPlanted(f, TRUTH.planted[0]), false);
});

test("scoreReview gives full recall and clean precision when both planted defects are found", () => {
  const findings = [
    finding({ severity: "critical", title: "SQL injection", body: "not parameterized", line_start: 10, line_end: 12 }),
    finding({ severity: "high", title: "Unguarded JSON.parse", body: "may throw", line_start: 40, line_end: 41 })
  ];
  const s = scoreReview(findings, TRUTH);
  assert.equal(s.found, 2);
  assert.equal(s.recall, 1);
  assert.equal(s.falsePositives, 0);
  assert.equal(s.precision, 1);
  assert.equal(s.severity.exact, 2);
  assert.equal(s.composite, 100);
});

test("scoreReview counts a false positive for an unmatched, non-allowed finding", () => {
  const findings = [
    finding({ severity: "critical", title: "SQL injection", body: "x", line_start: 10, line_end: 12 }),
    finding({ severity: "high", title: "Made-up async bug", body: "hallucinated", file: "src/auth.js", line_start: 99, line_end: 99 })
  ];
  const s = scoreReview(findings, TRUTH);
  assert.equal(s.found, 1);
  assert.equal(s.recall, 0.5);
  assert.equal(s.falsePositives, 1);
  assert.equal(s.bonus, 0);
  assert.deepEqual(s.missed, ["json-parse"]);
});

test("scoreReview credits an allowed extra as bonus, not a false positive", () => {
  const findings = [
    finding({ title: "SQL injection", body: "x", line_start: 10, line_end: 12 }),
    finding({ title: "Unguarded JSON.parse", body: "x", line_start: 40, line_end: 41 }),
    finding({ title: "JWT issued without expiry", body: "no expiresIn set", line_start: 25, line_end: 25 })
  ];
  const s = scoreReview(findings, TRUTH);
  assert.equal(s.found, 2);
  assert.equal(s.bonus, 1);
  assert.equal(s.falsePositives, 0);
  assert.equal(s.precision, 1);
});

test("extractJsonObject pulls a balanced object out of surrounding prose and fences", () => {
  const enveloped = 'Here is the review:\n```json\n{"verdict":"approve","findings":[]}\n```\nThanks!';
  assert.deepEqual(adapters.extractJsonObject(enveloped), { verdict: "approve", findings: [] });
});

test("extractJsonObject respects braces inside strings", () => {
  const text = '{"summary":"has a } brace","findings":[]}';
  assert.deepEqual(adapters.extractJsonObject(text), { summary: "has a } brace", findings: [] });
});

test("extractJsonObject returns null when there is no JSON object", () => {
  assert.equal(adapters.extractJsonObject("no json here"), null);
  assert.equal(adapters.extractJsonObject(null), null);
});

test("geminiInnerText unwraps the gemini --output-format json envelope across shapes", () => {
  assert.equal(adapters.geminiInnerText({ response: "hi" }, "fb"), "hi");
  assert.equal(adapters.geminiInnerText({ response: { text: "nested" } }, "fb"), "nested");
  assert.equal(
    adapters.geminiInnerText({ candidates: [{ content: { parts: [{ text: "api" }] } }] }, "fb"),
    "api"
  );
  assert.equal(adapters.geminiInnerText({ text: "top" }, "fb"), "top");
  assert.equal(adapters.geminiInnerText(null, "fallback"), "fallback");
});

test("normalizeReview coerces a missing findings array to []", () => {
  assert.deepEqual(adapters.normalizeReview({ verdict: "approve" }), {
    verdict: "approve",
    summary: null,
    findings: []
  });
  assert.equal(adapters.normalizeReview(null), null);
});

test("scoreReview flags severity miscalibration without dropping the catch", () => {
  const findings = [
    finding({ severity: "low", title: "SQL injection", body: "x", line_start: 10, line_end: 12 }), // expected critical
    finding({ severity: "high", title: "Unguarded JSON.parse", body: "x", line_start: 40, line_end: 41 })
  ];
  const s = scoreReview(findings, TRUTH);
  assert.equal(s.found, 2);
  assert.equal(s.severity.mismatch, 1); // low vs critical
  assert.equal(s.severity.exact, 1); // high vs high
});

// --- scorecard provenance ---------------------------------------------------
// A cassette that was never run still produces a composite, and the composite
// looks exactly like a measured one. These pin the one thing that separates them.

function scoreOf(composite) {
  return {
    composite,
    recall: 1,
    precision: 1,
    falsePositives: 0,
    bonus: 0,
    severityExactRate: 1,
    missed: []
  };
}

function row(cell, composite, seeded, caseId = "c1") {
  return {
    caseId,
    cell,
    status: "ok",
    score: scoreOf(composite),
    latencyMs: 1000,
    provenance: { seeded, recordedAt: "2026-08-19T00:00:00.000Z", engineVersion: seeded ? null : "1.1.14" }
  };
}

test("a seeded cell cannot win an axis, however high it scores", () => {
  const { summary, markdown } = buildScorecard([
    row("agy.deep", 50, false),
    row("codex.native", 99, true)
  ]);

  assert.notEqual(summary.harnessAxisWinner, "codex", "a cassette nobody ran must not win");
  assert.equal(summary.harnessAxisWinner, "—");
  assert.match(markdown, /not decidable: 1 of 2 cells measured/);
  assert.match(markdown, /codex 99 \(seeded\)/, "the seeded number is still shown, just labelled");
});

test("an axis names a winner once two measured cells disagree beyond noise", () => {
  const { summary } = buildScorecard([
    row("agy.deep", 90, false),
    row("codex.native", 60, false)
  ]);
  assert.equal(summary.harnessAxisWinner, "agy");
});

test("two measured cells within noise tie rather than crowning one", () => {
  const { summary } = buildScorecard([
    row("agy.deep", 90, false),
    row("codex.native", 89, false)
  ]);
  assert.equal(summary.harnessAxisWinner, "tie");
});

test("a harness lift with a seeded end is not reported as a measurement", () => {
  const { markdown, summary } = buildScorecard([
    row("gemini.model", 70, false),
    row("gemini.deep", 90, true)
  ]);

  assert.equal(summary.harnessLifts.gemini.seeded, true);
  assert.match(markdown, /Harness lift — gemini \| \+20 \| one end is seeded — not a measurement/);
});

test("a harness lift measured end to end says what it is", () => {
  const { markdown, summary } = buildScorecard([
    row("agy.model", 73, false),
    row("agy.deep", 90.5, false)
  ]);

  assert.equal(summary.harnessLifts.agy.seeded, false);
  assert.equal(summary.harnessLifts.agy.lift, 17.5);
  assert.match(markdown, /Harness lift — agy \| \+17.5 \| agy.model → agy.deep composite/);
});

test("the per-cell table carries the build a live cell was recorded against", () => {
  const { markdown } = buildScorecard([row("agy.deep", 90.5, false)]);
  assert.match(markdown, /live 2026-08-19 · 1.1.14/);
});
