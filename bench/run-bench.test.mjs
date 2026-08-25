import test from "node:test";
import assert from "node:assert/strict";

import { scoreReview, findingMatchesPlanted, normalizeFile } from "./lib/score.mjs";
import { CELL_IDS } from "./lib/cells.mjs";
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

// The real miss this pins: `repo-context` plants an undeclared-dependency defect
// with `file: "*"`, so matching is keyword-only, and one of its keywords was the
// bare module name. Every reviewer that discussed `src/token.js` at all wrote
// "jsonwebtoken" somewhere in the body, so a finding about an unvalidated secret
// was credited with catching a missing manifest entry it never mentioned. That
// single false credit was worth 42 composite points to one cell (96.7 -> 55.0) and
// not to others, which is worse than being wrong uniformly: it moved the cells
// relative to each other, and the whole benchmark is a comparison between cells.
//
// `match.all` is the subject the finding has to actually be about; `match.keywords`
// stays any-of, so a reviewer's choice of words for the claim is still free.
test("a wildcard defect is not credited to a finding about a different subject", () => {
  const truth = {
    planted: [
      {
        id: "missing-dependency",
        file: "*",
        line_start: 1,
        line_end: 1,
        severity: "high",
        match: {
          all: ["jsonwebtoken"],
          keywords: ["undeclared", "not declared", "missing dependency", "not in package.json"]
        }
      }
    ],
    allowed_extras: []
  };

  // Says the claim, about the wrong module. Keyword-only matching credits it.
  const wrongSubject = finding({
    severity: "high",
    title: "Missing dependency on the validation middleware",
    body: "src/routes/profile.js calls validateBody(), which is not declared anywhere in this package.",
    file: "src/routes/profile.js"
  });
  // Names the subject, makes a different claim. `all` alone would credit it.
  const wrongClaim = finding({
    severity: "critical",
    title: "JWT_SECRET used without validation",
    body: "process.env.JWT_SECRET goes straight to jwt.sign(). Empty string, and jsonwebtoken signs with a zero-length secret.",
    file: "src/token.js"
  });
  // Both: this is the finding the defect was planted for.
  const theCatch = finding({
    severity: "high",
    title: "Undeclared 'jsonwebtoken' dependency",
    body: "src/token.js requires jsonwebtoken, which is not declared in package.json.",
    file: "src/token.js"
  });

  assert.equal(findingMatchesPlanted(wrongSubject, truth.planted[0]), false);
  assert.equal(findingMatchesPlanted(wrongClaim, truth.planted[0]), false);
  assert.equal(findingMatchesPlanted(theCatch, truth.planted[0]), true);

  const missed = scoreReview([wrongSubject, wrongClaim], truth);
  assert.equal(missed.found, 0);
  assert.equal(missed.falsePositives, 2);
  assert.deepEqual(missed.missed, ["missing-dependency"]);

  const caught = scoreReview([theCatch], truth);
  assert.equal(caught.found, 1);
  assert.equal(caught.falsePositives, 0);
});

test("every term in `all` has to be there, not just one of them", () => {
  const planted = {
    id: "unread-config-key",
    file: "*",
    line_start: 1,
    line_end: 1,
    severity: "high",
    match: { all: ["maxbatch", "default.json"], keywords: ["missing", "absent", "not defined"] }
  };

  // Names the key, blames the wrong file. One of two required terms.
  const halfRight = finding({
    title: "config.maxBatch is missing",
    body: "worker.js reads config.maxBatch, which nothing in src/ ever defines.",
    file: "src/worker.js"
  });
  const bothTerms = finding({
    title: "config.maxBatch is missing from the shipped config",
    body: "src/worker.js reads config.maxBatch; config/default.json does not define it.",
    file: "src/worker.js"
  });

  assert.equal(findingMatchesPlanted(halfRight, planted), false);
  assert.equal(findingMatchesPlanted(bothTerms, planted), true);
});

// A guard on the corpus rather than on the scorer. A `file: "*"` defect has no
// filename to disambiguate it, so words are the whole rule, and the failure this
// pins is silent: the defect keeps matching, just too much. Requiring `all` does
// not make the subject right — it makes leaving the subject out a test failure
// instead of a number nobody questions.
test("every repository-scoped defect declares the subject it is about", () => {
  const corpusDir = path.join(import.meta.dirname, "corpus");
  const cases = fs
    .readdirSync(corpusDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.ok(cases.length > 0, "corpus is empty");

  const offenders = [];
  for (const caseId of cases) {
    const file = path.join(corpusDir, caseId, "ground-truth.json");
    if (!fs.existsSync(file)) continue;
    const truth = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const p of truth.planted ?? []) {
      if (p.file && p.file !== "*") continue;
      if (!Array.isArray(p.match?.all) || p.match.all.length === 0) {
        offenders.push(`${caseId}/${p.id}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// The README's cell table is the only place a reader learns what is on the board,
// and it drifted silently: two cells were added and the table kept describing nine.
// A table that omits a cell does not look broken, it looks complete.
test("the README's cell table lists exactly the cells that exist", () => {
  // Normalize line endings first. A Windows checkout stores this file with CRLF, so
  // searching for "\n\n" finds nothing, and `slice(from, -1)` then hands the rest of
  // the README to a regex that happily matches every later table too.
  const readme = fs
    .readFileSync(path.join(import.meta.dirname, "README.md"), "utf8")
    .replace(/\r\n/g, "\n");
  const from = readme.indexOf("| Cell | What it is | Isolates |");
  assert.notEqual(from, -1, "cell table header not found in bench/README.md");
  const until = readme.indexOf("\n\n", from);
  assert.notEqual(until, -1, "cell table is not followed by a blank line");
  const table = readme.slice(from, until);
  const documented = [...table.matchAll(/^\| `([a-z]+\.[a-z]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...documented].sort(), [...CELL_IDS].sort());
});

test("the README's ablation table agrees with the ablation artifact", () => {
  // The README prints means over two cases; the artifact's `summary` is per-case and
  // arm A also ran a third. Printing one and storing the other is how the six drifts
  // this branch fixed got in, so the artifact carries the exact printed table too.
  const readme = fs
    .readFileSync(path.join(import.meta.dirname, "README.md"), "utf8")
    .replace(/\r\n/g, "\n");
  const artifact = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "ablations", "prompt-penalty-2026-08-25.json"), "utf8")
  );

  const from = readme.indexOf("> | arm | removed | composite | recall | findings |");
  assert.notEqual(from, -1, "ablation table header not found in bench/README.md");
  const until = readme.indexOf("\n>\n", from);
  assert.notEqual(until, -1, "ablation table is not followed by a blank quoted line");
  const rows = [...readme.slice(from, until).matchAll(/^> \| `?([A-Za-z.]+)`? \|[^|]*\| ([\d.]+) \| ([\d.]+) \| ([\d.]+) \|$/gm)];
  assert.equal(rows.length, 4, "expected four data rows in the ablation table");

  for (const [, arm, composite, recall, findings] of rows) {
    const stored = artifact.comparisonTable[arm];
    assert.ok(stored, `README names arm ${arm}, artifact does not`);
    // The README rounds to one decimal; the artifact keeps two.
    assert.equal(Number(composite), Math.round(stored.composite * 10) / 10, `${arm} composite`);
    assert.equal(Number(recall), stored.recall, `${arm} recall`);
    assert.equal(Number(findings), stored.findingsCount, `${arm} findings`);
  }
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

test("a cell refuses a run from an engine other than its own", () => {
  // Pinning --engine stops the environment redirecting a cell; it does not prove
  // the pin was honoured, and that failure is silent — the cassette stays green
  // carrying another engine's answers, which is exactly what gemini.deep did for
  // its entire life. The companion reports the engine it resolved; this compares.
  assert.equal(adapters.assertExpectedEngine({ engine: "gemini" }, "gemini"), null, "a match passes");

  const wrong = adapters.assertExpectedEngine({ engine: "agy" }, "gemini");
  assert.match(String(wrong), /expects gemini/, "the failure names what the cell wanted");
  assert.match(String(wrong), /ran agy/, "and what actually ran");
});

test("the cell actually calls the check — a mismatching run is rejected end to end", () => {
  // The two tests below cover `assertExpectedEngine`; this one covers whether
  // anything calls it. Deleting the call site left the helper correct, unreachable,
  // and every test green, which is the defect this check exists to prevent wearing
  // a different hat.
  const stub = () => ({
    status: 0,
    stdout: JSON.stringify({ engine: "agy", result: { verdict: "needs-attention", summary: "s", findings: [] } }),
    stderr: ""
  });

  const rejected = adapters.runCompanionReview("/companion.mjs", "/repo", ["--deep"], "gemini", { spawnImpl: stub });
  assert.equal(rejected.ok, false, "a gemini cell must not accept an AGY run");
  assert.match(String(rejected.error), /expects gemini.*ran agy/);

  const accepted = adapters.runCompanionReview("/companion.mjs", "/repo", ["--deep"], "agy", { spawnImpl: stub });
  assert.equal(accepted.ok, true, "the same run is fine for the cell it belongs to");
  assert.equal(accepted.engineObserved, "agy", "and the cassette records what ran, not what was asked for");
});

test("a companion that cannot say which engine ran is a failure, not a pass", () => {
  // Absence is the case that cannot be checked. Reading "no answer" as "the right
  // answer" is how the original defect survived every green run.
  const silent = adapters.assertExpectedEngine({ result: {} }, "gemini");
  assert.match(String(silent), /did not report/, "an unreporting companion fails the cell");

  assert.equal(adapters.assertExpectedEngine({ engine: null }, null), null, "a cell with no expectation is unaffected");
});

test("a refused AGY run reports the reason AGY gave, not an empty parenthesis", () => {
  // AGY puts a refusal in the envelope's `error` and leaves stderr empty. The
  // failure message used to echo stderr alone, so a spent account read as
  // `could not parse review JSON ()` — indistinguishable from a parser bug, and
  // diagnosed as one for three recording attempts.
  const quotaEnvelope = {
    conversation_id: "5504cb18",
    status: "ERROR",
    response: "",
    error: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 94h2m50s."
  };
  const stub = () => ({ status: 1, stdout: JSON.stringify(quotaEnvelope), stderr: "" });

  const refused = adapters.runAgyModel("review this", { spawnImpl: stub, resolveBinaryImpl: () => "/usr/bin/agy" });
  assert.equal(refused.ok, false, "an envelope carrying no review is still a failure");
  assert.match(String(refused.error), /Individual quota reached/);
});

test("a spawn that never returned still says why", () => {
  // The sibling test above covers a run that came back; this covers one that did not.
  // `res.error.message` is `spawnSync ... ETIMEDOUT`, which names the symptom, and the
  // reason the CLI printed sits on the same `res`. It used to be dropped. Field note
  // gi-2026-08-24-b7c1 is the bill: gemini was retrying an HTTP 429 spending-cap
  // rejection past the cap, the bench reported a timeout, and a spent account was
  // investigated for a day as engine slowness. Shape below is the real capture's:
  // the attempts are numbered, so no two of them are equal.
  const stderr = [
    "Warning: True color (24-bit) support not detected.",
    'Attempt 1 failed with status 429. _ApiError: {"error":{"message":"Your project has exceeded its monthly spending cap.","status":"RESOURCE_EXHAUSTED"}}',
    "    at throwErrorIfNotOK (file:///C:/x/chunk.js:267240:24)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
    'Attempt 2 failed with status 429. _ApiError: {"error":{"message":"Your project has exceeded its monthly spending cap.","status":"RESOURCE_EXHAUSTED"}}'
  ].join("\n");

  const reported = adapters.spawnFailure("gemini", {
    error: { message: "spawnSync cmd.exe ETIMEDOUT" },
    stderr
  });

  assert.equal(reported.ok, false);
  assert.match(String(reported.error), /spawnSync cmd\.exe ETIMEDOUT/, "the symptom is still named");
  assert.match(String(reported.error), /exceeded its monthly spending cap/, "and so is the cause");
  // Frames say where in the CLI's bundle the throw happened, which no reader can act on.
  assert.doesNotMatch(String(reported.error), /throwErrorIfNotOK|processTicksAndRejections/);
});

test("the cause survives whatever the CLI prints after it", () => {
  // The first fix here kept the tail of the message, which reads as the safe end to
  // keep until deduplication moves the cause to the front -- then the tail slice cuts
  // it off mid-word and the failure reports a shutdown epilogue instead. Reviewed and
  // reproduced: `(ding cap. RESOURCE_EXHAUSTED Terminated after 180s. For
  // troubleshooting, see ... Auth: oauth-personal.)`. That is the original defect
  // rebuilt inside its own fix, so the shape is pinned here.
  const cause = "_ApiError: Your project has exceeded its monthly spending cap. RESOURCE_EXHAUSTED";
  const stderr = [
    ...Array.from({ length: 30 }, () => cause),
    "Terminated after 180s.",
    "For troubleshooting, see https://goo.gle/gemini-cli-docs and https://ai.google.dev/gemini-api/docs/troubleshooting for the full list of error codes.",
    "Session ID: 4f3c9a12-7b8e-4d21-9c05-1a2b3c4d5e6f",
    "Data collection is disabled. Auth: oauth-personal."
  ].join("\n");

  const reported = adapters.spawnFailure("gemini", { error: { message: "ETIMEDOUT" }, stderr });
  assert.match(String(reported.error), /exceeded its monthly spending cap/);
});

test("a flood of one repeated line does not crowd out what came after it", () => {
  // What deduplication is actually for, now that the budget is wide. Not what the
  // first version of this test claimed: the real capture numbers its attempts
  // (`Attempt 1 failed`, `Attempt 2 failed`), so those lines are never equal and
  // deduplication does nothing to them. It earns its place on a CLI that repeats one
  // line often enough to spend the whole budget, which is what is built here.
  // Long enough, and repeated often enough, that the copies alone overrun the budget:
  // a fixture that fits under it passes whether or not anything is deduplicated.
  const repeated = 'Attempt failed with status 429. _ApiError: {"error":{"message":"rate limited, retrying"}}';
  const stderr = [...Array.from({ length: 60 }, () => repeated), "Terminated after 180s."].join("\n");

  const reported = adapters.spawnFailure("gemini", { error: { message: "ETIMEDOUT" }, stderr });
  assert.match(String(reported.error), /rate limited/, "the repeated line is still reported");
  assert.match(String(reported.error), /Terminated after 180s/, "and so is what followed it");
});

test("a diagnosis on stdout is not lost to a blank stderr", () => {
  // `res.stderr || res.stdout` picks a stream by truthiness rather than by content, so
  // a single newline on stderr won and stdout was discarded -- restoring the very
  // silence this helper exists to end, without changing the code that ends it.
  const reported = adapters.spawnFailure("codex", {
    error: { message: "ETIMEDOUT" },
    stderr: "\n",
    stdout: "You've hit your usage limit."
  });
  assert.match(String(reported.error), /hit your usage limit/);
});

test("a spawn failure with nothing to add does not report an empty parenthesis", () => {
  // The failure this whole path exists to avoid, in its other direction: `(...)` with
  // nothing in it reads as a defect in the bench rather than silence from the CLI.
  const bare = adapters.spawnFailure("agy", { error: { message: "spawnSync ENOENT" }, stderr: "", stdout: "" });
  assert.equal(bare.error, "agy spawn: spawnSync ENOENT");
});

test("every adapter routes a failed spawn through the same reporting", () => {
  // Pins the wiring, not just the helper: a correct helper that no adapter calls is
  // exactly the state this change found the file in. All four are named because all
  // four had the defect -- and the one the field note was recorded against is gemini,
  // which is the cell a helper-only test would have left unprotected.
  const stub = () => ({ error: { message: "spawnSync ETIMEDOUT" }, stdout: "", stderr: "Individual quota reached." });
  const runs = [
    ["gemini", adapters.runGeminiModel("review this", { spawnImpl: stub })],
    ["agy", adapters.runAgyModel("review this", { spawnImpl: stub, resolveBinaryImpl: () => "/usr/bin/agy" })],
    ["codex", adapters.runCodexModel("review this", { spawnImpl: stub })],
    ["companion", adapters.runCompanionReview("/companion.mjs", "/repo", [], null, { spawnImpl: stub })]
  ];
  for (const [name, result] of runs) {
    assert.equal(result.ok, false, `${name} reports a failure`);
    assert.match(String(result.error), /Individual quota reached/, `${name} carries the reason the CLI gave`);
  }
});

test("a cell whose cases were recorded on different versions says so", () => {
  // Taking the first cassette's version to stand for the cell is how a table states
  // what a column is supposed to hold rather than what it holds. `agy.model` really
  // did end up four cases on 1.1.19 and one on 1.1.15 after a re-record was refused.
  const row = (caseId, engineVersion) => ({
    caseId,
    cell: "agy.model",
    status: "ok",
    score: { composite: 90, recall: 1, precision: 1, falsePositives: 0, bonus: 0, severityExactRate: 1, missed: [] },
    latencyMs: 1000,
    provenance: { seeded: false, recordedAt: "2026-08-24T00:00:00.000Z", engineVersion, samples: 3 }
  });

  const mixed = buildScorecard([row("c1", "1.1.19"), row("c2", "1.1.19"), row("c3", "1.1.15")]);
  assert.match(mixed.markdown, /1\.1\.19 ×3 · 1 case on 1\.1\.15/);

  const uniform = buildScorecard([row("c1", "1.1.19"), row("c2", "1.1.19")]);
  assert.doesNotMatch(uniform.markdown, /case on/, "a cell recorded on one version says nothing extra");
});

test("the adversarial cells run their tool's adversarial subcommand, not review", () => {
  // The whole reason the adversarial axis exists is that these are a different
  // reviewer, so a cell that quietly ran `review` would make the axis a duplicate
  // of the harness one under a different name.
  const seen = [];
  const stub = (_bin, args) => {
    seen.push(args);
    return {
      status: 0,
      stdout: JSON.stringify({ engine: "agy", result: { verdict: "approve", summary: "s", findings: [] } }),
      stderr: ""
    };
  };

  adapters.runCompanionReview("/companion.mjs", "/repo", ["--deep"], "agy", {
    spawnImpl: stub,
    subcommand: "adversarial-review"
  });
  assert.equal(seen[0][1], "adversarial-review");

  adapters.runCompanionReview("/companion.mjs", "/repo", ["--deep"], "agy", { spawnImpl: stub });
  assert.equal(seen[1][1], "review", "the default stays what every existing cell passes");
});

test("the scorecard carries an adversarial axis of its own", () => {
  // Folding these into the harness axis would rank a prompt that asks the model to
  // break confidence in the change against one that asks for a pragmatic review.
  const row = (cell, composite) => ({
    caseId: "c1",
    cell,
    status: "ok",
    score: { composite, recall: 1, precision: 1, falsePositives: 0, bonus: 0, severityExactRate: 1, missed: [] },
    latencyMs: 1000,
    provenance: { seeded: false, recordedAt: "2026-08-24T00:00:00.000Z", engineVersion: "1.1.19", samples: 3 }
  });

  const card = buildScorecard([row("agy.adversarial", 90), row("codex.adversarial", 60), row("agy.deep", 80)]);
  const lineFor = (name) => String(card.markdown.split(/\r?\n/).find((l) => l.includes(`**${name}**`)));

  // Assert what each axis *contains*, not merely that a row with the right title was
  // printed: pointing the adversarial axis at the harness track still renders the
  // row, so a title-only assertion passes while the axis reads the wrong cells.
  const adversarial = lineFor("Adversarial");
  assert.match(adversarial, /agy 90/);
  assert.match(adversarial, /codex 60/);
  assert.doesNotMatch(adversarial, /80/, "agy.deep belongs to the harness axis, not this one");

  const harness = lineFor("Harness");
  assert.match(harness, /agy 80/);
  assert.doesNotMatch(harness, /90|60/, "the adversarial cells must not leak into the harness axis");
});

// A planted defect may declare `file: "*"` when it spans files, and `fileMatches`
// honours that. Extras did not: the comparison was literal, `"*"` is truthy, and so a
// legitimate catch of a repository-wide extra was charged as a false positive. The
// cost landed on whichever cell found it, rather than spreading evenly. Whether that
// moves a published number depends on which cassettes are present; the scorecard is
// where that is read off, not a comment.
test("an allowed extra declared for the whole repository is credited, not penalised", () => {
  const truth = {
    planted: [{ id: "planted-one", file: "src/store.js", match: { keywords: ["null deref"] } }],
    allowed_extras: [{ id: "repo-wide", file: "*", match: { keywords: ["breaking change"] } }]
  };
  const findingOfTheExtra = {
    file: "src/anywhere.js",
    title: "Breaking change to findUser return contract breaks existing callers",
    severity: "medium"
  };

  const scored = scoreReview([findingOfTheExtra], truth);
  assert.equal(scored.bonus, 1, "a wildcard extra is a legitimate unique catch");
  assert.equal(scored.falsePositives, 0, "and must not also be charged as a false positive");
});

// The other half of the rule, so the fix cannot become "extras match anything". An
// extra that names a file still means that file.
test("an allowed extra that names a file still only matches that file", () => {
  const truth = {
    planted: [],
    allowed_extras: [{ id: "scoped", file: "src/store.js", match: { keywords: ["breaking change"] } }]
  };
  const elsewhere = { file: "src/other.js", title: "Breaking change in the other module", severity: "low" };
  const here = { file: "src/store.js", title: "Breaking change in the store", severity: "low" };

  assert.equal(scoreReview([elsewhere], truth).bonus, 0, "a different file is not the extra");
  assert.equal(scoreReview([elsewhere], truth).falsePositives, 1);
  assert.equal(scoreReview([here], truth).bonus, 1, "the named file is");
});

// Keywords still gate a wildcard extra. Without this the fix would turn `file: "*"`
// into "any unmatched finding is a bonus", which would inflate every cell instead of
// deflating one -- the same defect with its sign flipped.
test("a wildcard extra still has to match on keywords", () => {
  const truth = {
    planted: [],
    allowed_extras: [{ id: "repo-wide", file: "*", match: { keywords: ["breaking change"] } }]
  };
  const unrelated = { file: "src/anywhere.js", title: "Variable named badly", severity: "low" };

  const scored = scoreReview([unrelated], truth);
  assert.equal(scored.bonus, 0);
  assert.equal(scored.falsePositives, 1, "an unrelated finding is still a false positive");
});

// Honouring `"*"` is only safe if the extras themselves name a subject. `stale-duplicate`
// listed the bare module name among its any-of keywords, which was inert while a wildcard
// extra could never match and became repo-wide false-positive amnesty the moment it could:
// any finding anywhere whose body merely mentioned `worker.js` was credited as a legitimate
// catch. This is the same defect score.mjs already documents for `repo-context`, which is
// why the subject now sits in `match.all`. Run against the real ground truth, not a fixture,
// because the hazard was in the corpus rather than in the scorer.
test("mentioning the subject is not catching the extra", () => {
  const truth = JSON.parse(
    fs.readFileSync(new URL("./corpus/stale-duplicate/ground-truth.json", import.meta.url), "utf8")
  );
  const inPassing = {
    file: "src/unrelated.js",
    title: "Inconsistent logging",
    body: "The log format here differs from the one used in worker.js",
    severity: "low"
  };
  const theCatch = {
    file: "src/worker.js",
    title: "worker.js is never imported by any entry point",
    body: "unused module",
    severity: "medium"
  };

  const passing = scoreReview([inPassing], truth);
  assert.equal(passing.bonus, 0, "a passing mention is not the claim");
  assert.equal(passing.falsePositives, 1, "and is still charged");

  const caught = scoreReview([theCatch], truth);
  assert.equal(caught.bonus, 1, "the claim, about the subject, is credited");
  assert.equal(caught.falsePositives, 0);
});

// Planted defects are consumed; extras were not. Bounded to one file that was survivable,
// but a wildcard extra with no consumption is an unlimited amnesty: restate one claim N
// times and collect N bonuses and no false positives. Padding output would have become
// free, which is the opposite of what this board is for.
test("one extra is one catch, however many times it is restated", () => {
  const truth = {
    planted: [],
    allowed_extras: [{ id: "repo-wide", file: "*", match: { keywords: ["breaking change"] } }]
  };
  const claim = { file: "src/a.js", title: "Breaking change to the return contract", severity: "medium" };
  const restated = [claim, { ...claim, file: "src/b.js" }, { ...claim, file: "src/c.js" }];

  const scored = scoreReview(restated, truth);
  assert.equal(scored.bonus, 1, "credited once");
  assert.equal(scored.falsePositives, 2, "the repeats are still noise");
});

// The Source column took its date from the first cassette alone, which is fine only
// while a cell was recorded in one sitting. `agy.adversarial` broke that: five cases on
// one day and two the next printed as a single day, so the column stated when the cell
// was supposed to have been recorded rather than what it holds. That is the same
// failure the version column was fixed for, on a second axis.
test("a cell recorded across two days says so", () => {
  const row = (caseId, recordedAt) => ({
    caseId,
    cell: "agy.adversarial",
    status: "ok",
    score: { composite: 80, recall: 0.8, precision: 0.9, falsePositives: 0, bonus: 0, severityExactRate: 0.5, missed: [] },
    latencyMs: 1000,
    provenance: { seeded: false, recordedAt, engineVersion: "1.1.19", samples: 3 }
  });

  const twoDays = buildScorecard([
    row("c1", "2026-08-24T00:00:00.000Z"),
    row("c2", "2026-08-24T00:00:00.000Z"),
    row("c3", "2026-08-25T00:00:00.000Z")
  ]);
  assert.match(twoDays.markdown, /live 2026-08-24, 2026-08-25/, "both days are named");

  // And a cell recorded in one sitting keeps the plain date -- a range on every row
  // would make "recorded once" and "recorded twice" read the same again.
  const oneDay = buildScorecard([row("c1", "2026-08-24T00:00:00.000Z"), row("c2", "2026-08-24T09:00:00.000Z")]);
  assert.match(oneDay.markdown, /live 2026-08-24 ·/);
  assert.doesNotMatch(oneDay.markdown, /2026-08-24,/);

  // Days are listed, not dashed. `gemini.deep` really does hold 2026-08-19 and
  // 2026-08-24 -- two sittings five days apart -- and `2026-08-19–2026-08-24` reads as
  // five days of recording that never happened. Everything between the endpoints is a
  // day this cell has nothing from.
  const apart = buildScorecard([row("c1", "2026-08-19T00:00:00.000Z"), row("c2", "2026-08-24T00:00:00.000Z")]);
  assert.match(apart.markdown, /live 2026-08-19, 2026-08-24/, "both sittings, neither invented");
  assert.doesNotMatch(apart.markdown, /2026-08-19–/, "and not as a span");
});
