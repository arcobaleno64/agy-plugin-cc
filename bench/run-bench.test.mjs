import test from "node:test";
import assert from "node:assert/strict";

import { scoreReview, findingMatchesPlanted, normalizeFile } from "./lib/score.mjs";
import { _internal as adapters } from "./lib/adapters.mjs";
import { buildScorecard } from "./lib/report.mjs";
import { cassettePath, writeCassette } from "./lib/cassette.mjs";
import { _internal as bench } from "./run-bench.mjs";
import fs from "node:fs";
import path from "node:path";

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

function row(cell, composite, seeded, spread = 2, caseId = "c1") {
  return {
    caseId,
    cell,
    status: "ok",
    score: scoreOf(composite),
    spread,
    latencyMs: 1000,
    provenance: {
      seeded,
      recordedAt: "2026-08-19T00:00:00.000Z",
      engineVersion: seeded ? null : "1.1.14",
      samples: spread == null ? 1 : 3
    }
  };
}

test("a seeded cell cannot win an axis, however high it scores", () => {
  const { summary, markdown } = buildScorecard([
    row("agy.deep", 50, false),
    row("codex.native", 99, true)
  ]);

  assert.notEqual(summary.harnessAxisWinner, "codex", "a cassette nobody ran must not win");
  assert.equal(summary.harnessAxisWinner, "—");
  assert.match(markdown, /not decidable: 1 of 2 cells carry repeated measurements/);
  assert.match(markdown, /codex 99 \(seeded\)/, "the seeded number is still shown, just labelled");
});

test("an axis names a winner once the lead clears the movement behind it", () => {
  const { summary } = buildScorecard([
    row("agy.deep", 90, false, 5),
    row("codex.native", 60, false, 5)
  ]);
  assert.equal(summary.harnessAxisWinner, "agy", "a 30-point lead over cells that move ±5");
});

test("a lead inside the spread is a tie, however many points it is", () => {
  // The old rule was a hardcoded 2-point band, which would have called this
  // decisive. On this corpus one cell really did move 0 -> 65 between repeats.
  const { summary, markdown } = buildScorecard([
    row("agy.deep", 90, false, 65),
    row("codex.native", 60, false, 5)
  ]);
  assert.equal(summary.harnessAxisWinner, "tie");
  assert.match(markdown, /lead of 30 does not clear the ±65/);
});

test("a cell recorded once cannot enter a verdict, because its noise is unknown", () => {
  const { summary, markdown } = buildScorecard([
    row("agy.deep", 60, false, 5),
    row("codex.native", 99, false, null)
  ]);

  assert.notEqual(summary.harnessAxisWinner, "codex", "99 from a single run must not win");
  assert.equal(summary.harnessAxisWinner, "—");
  assert.match(markdown, /codex 99 \(1 sample\)/, "shown, and shown to be one sample");
});

test("two measured cells within noise tie rather than crowning one", () => {
  const { summary } = buildScorecard([
    row("agy.deep", 90, false, 5),
    row("codex.native", 89, false, 5)
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

test("a harness lift measured end to end, and clear of its noise, says so", () => {
  const { markdown, summary } = buildScorecard([
    row("agy.model", 73, false, 5),
    row("agy.deep", 90.5, false, 5)
  ]);

  assert.equal(summary.harnessLifts.agy.seeded, false);
  assert.equal(summary.harnessLifts.agy.lift, 17.5);
  assert.equal(summary.harnessLifts.agy.established, true);
  assert.match(markdown, /Harness lift — agy \| \+17.5 \| .*clear of the ±5 its ends move/);
});

test("a lift no wider than its ends' own movement is not a lift", () => {
  const { markdown, summary } = buildScorecard([
    row("agy.model", 64, false, 65),
    row("agy.deep", 85, false, 16)
  ]);

  assert.equal(summary.harnessLifts.agy.established, false);
  assert.equal(summary.harnessLifts.agy.band, 65);
  assert.match(markdown, /Harness lift — agy \| \+21 \| does not clear the ±65/);
});

test("a lift with a single-sample end reports that rather than a number it cannot back", () => {
  const { markdown, summary } = buildScorecard([
    row("gemini.model", 73, false, null),
    row("gemini.deep", 84.5, false, 1)
  ]);

  assert.equal(summary.harnessLifts.gemini.band, null);
  assert.equal(summary.harnessLifts.gemini.established, false);
  assert.match(markdown, /Harness lift — gemini \| \+11.5 \| one end was recorded once/);
});

test("the per-cell table carries the build a live cell was recorded against", () => {
  const { markdown } = buildScorecard([row("agy.deep", 90.5, false)]);
  assert.match(markdown, /live 2026-08-19 · 1.1.14/);
});

// --- repeats have to survive into replay ------------------------------------
// The published scorecard comes from replay, so an average that exists only in a
// live run is an average nobody ever reads. `--repeats N` used to store the last
// run and average nothing that lasted.

const PERFECT = [
  finding({ severity: "critical", title: "SQL injection", body: "not parameterized", line_start: 10, line_end: 12 }),
  finding({ severity: "high", title: "Unguarded JSON.parse", body: "may throw", line_start: 40, line_end: 41 })
];

function scratchCassette(t, cell, payload) {
  // A case id with no corpus entry, so a stray file could never join a real run.
  const caseId = "__scratch-" + cell.replace(/\W/g, "-");
  const file = cassettePath(caseId, cell);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  t.after(() => {
    try {
      fs.rmSync(path.dirname(file), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error) {
      process.stderr.write(`left ${path.dirname(file)} for the OS: ${error?.code}\n`);
    }
  });
  return caseId;
}

test("replaying a cassette recorded with repeats averages them instead of taking the last", (t) => {
  const caseId = scratchCassette(t, "agy.model", {
    caseId: "x",
    cell: "agy.model",
    recordedAt: "2026-08-19T00:00:00.000Z",
    engineVersion: "1.1.14",
    verdict: "approve",
    summary: "last run",
    findings: [],
    latencyMs: 300,
    samples: [
      { verdict: "needs-attention", summary: "1", findings: PERFECT, latencyMs: 100 },
      { verdict: "needs-attention", summary: "2", findings: PERFECT, latencyMs: 200 },
      { verdict: "approve", summary: "3", findings: [], latencyMs: 300 }
    ]
  });

  const row = bench.replayCell({ caseId, cell: "agy.model", truth: TRUTH });

  assert.equal(row.status, "ok");
  assert.notEqual(row.score.composite, 0, "0 is the last run alone — the flaw this exists to catch");
  assert.equal(row.score.composite, 67, "(100 + 100 + 0) / 3");
  assert.equal(row.provenance.samples, 3, "and the reader is told it is an average of three");
  assert.equal(row.spread, 100, "and how far those three moved: two perfect runs and one empty one");
  assert.equal(row.latencyMs, 200, "latency averages with the score, not the last run's");
});

test("a cassette recorded before repeats existed still replays as a single sample", (t) => {
  const caseId = scratchCassette(t, "agy.deep", {
    caseId: "x",
    cell: "agy.deep",
    recordedAt: "2026-06-04T00:00:00.000Z",
    verdict: "needs-attention",
    summary: "one run",
    findings: PERFECT,
    latencyMs: 1234
  });

  const row = bench.replayCell({ caseId, cell: "agy.deep", truth: TRUTH });

  assert.equal(row.score.composite, 100, "scored from the top-level findings, exactly as before");
  assert.equal(row.provenance.samples, 1);
  assert.equal(row.spread, null, "one run cannot show its own movement, and null is not zero");
  assert.equal(row.latencyMs, 1234);
});

test("writeCassette keeps every repeat, not just the one it reports at the top", (t) => {
  const cell = "agy.model";
  const caseId = scratchCassette(t, cell, { placeholder: true });
  writeCassette(
    caseId,
    cell,
    { verdict: "approve", summary: "last", findings: [], latencyMs: 300, engineVersion: "1.1.14" },
    [
      { verdict: "needs-attention", summary: "1", findings: PERFECT, latencyMs: 100 },
      { verdict: "approve", summary: "last", findings: [], latencyMs: 300 }
    ]
  );

  const stored = JSON.parse(fs.readFileSync(cassettePath(caseId, cell), "utf8"));
  assert.equal(stored.samples.length, 2);
  assert.equal(stored.samples[0].findings.length, 2, "the run that was not last is still there");
  assert.equal(stored.findings.length, 0, "and the top level is still the last run");
});

test("the per-cell table shows the movement behind each number", () => {
  const { markdown } = buildScorecard([row("agy.deep", 85, false, 16), row("gemini.deep", 84.5, false, null)]);
  assert.match(markdown, /±16/, "a measured spread is printed");
  assert.match(markdown, /Gemini \(--deep, agentic\) \|[^|]*\|[^|]*\|[^|]*\| — \|/, "and an unknown one is a dash, not a zero");
});

test("the source column says how many samples a number came from", () => {
  const withRepeats = buildScorecard([
    {
      caseId: "c1",
      cell: "agy.deep",
      status: "ok",
      score: { composite: 90, recall: 1, precision: 1, falsePositives: 0, bonus: 0, severityExactRate: 1, missed: [] },
      latencyMs: 1000,
      provenance: { seeded: false, recordedAt: "2026-08-19T00:00:00.000Z", engineVersion: "1.1.14", samples: 5 }
    }
  ]);
  assert.match(withRepeats.markdown, /live 2026-08-19 · 1.1.14 ×5/);

  const single = buildScorecard([
    {
      caseId: "c1",
      cell: "agy.deep",
      status: "ok",
      score: { composite: 90, recall: 1, precision: 1, falsePositives: 0, bonus: 0, severityExactRate: 1, missed: [] },
      latencyMs: 1000,
      provenance: { seeded: false, recordedAt: "2026-08-19T00:00:00.000Z", engineVersion: "1.1.14", samples: 1 }
    }
  ]);
  assert.doesNotMatch(single.markdown, /×1/, "one sample is the default, and saying so would be noise");
});

// --- silence must not outscore effort ----------------------------------------

test("an empty review scores nothing when there was something to find", () => {
  // Precision used to be 1 over zero findings, which paid 20 points for silence —
  // more than naming one thing and being wrong, which pays 0. A benchmark that
  // rewards not looking cannot be evidence that looking helps.
  const silent = scoreReview([], TRUTH);
  const wrong = scoreReview([finding({ file: "src/unrelated.js", title: "nothing here" })], TRUTH);

  assert.equal(silent.composite, 0, "saying nothing earns nothing");
  assert.ok(
    silent.composite <= wrong.composite,
    `silence (${silent.composite}) must not beat a wrong answer (${wrong.composite})`
  );
});

test("an empty review is still correct when there is nothing planted to find", () => {
  // The exception the rule above must not swallow: a clean diff reviewed as clean.
  const clean = scoreReview([], { planted: [], allowed_extras: [] });
  assert.equal(clean.precision, 1, "nothing to find, nothing wrongly claimed");
  assert.equal(clean.composite, 90, "recall 1 and precision 1; severity has nothing to grade");
});

// --- a cell must run the engine its column header names -----------------------

test("the companion cells do not inherit an engine from the environment", () => {
  // GEMINI_ENGINE=agy in ~/.claude/settings.json silently redirected the
  // gemini.deep cell to AGY for every recording it ever made, while the cassette
  // was stamped from `gemini --version`. Stripping the variable is half the fix;
  // the other half is the explicit --engine below.
  const env = adapters.companionSpawnEnv({ GEMINI_ENGINE: "agy", PATH: "/usr/bin", HOME: "/home/x" });

  assert.equal("GEMINI_ENGINE" in env, false, "the child must not inherit an engine preference");
  assert.equal(env.PATH, "/usr/bin", "everything else is passed through untouched");
  assert.equal(env.HOME, "/home/x");
});

test("each companion cell names its engine on the command line", () => {
  // Stripping the variable leaves `auto`, which resolves by credential and would
  // hand gemini.deep to AGY again on any machine where the gemini credential is
  // the broken one. The engine has to be stated, not defaulted.
  const source = fs.readFileSync(new URL("./lib/adapters.mjs", import.meta.url), "utf8");

  for (const [cell, engine] of [["gemini.deep", "gemini"], ["agy.deep", "agy"]]) {
    const branch = source.slice(source.indexOf(`case "${cell}":`));
    const call = branch.slice(0, branch.indexOf(";") + 1);
    assert.ok(
      call.includes(`"--engine", "${engine}"`),
      `${cell} must pin --engine ${engine}; got: ${call.trim()}`
    );
  }
});
