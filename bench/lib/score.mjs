// Pure, deterministic scoring of review findings against a ground-truth manifest.
// Both the gemini and codex review paths emit the same structured shape
// (see bench/review-output.schema.json), so one scorer grades both.
//
// finding:  { severity, title, body, file, line_start, line_end, confidence, recommendation }
// planted:  { id, category, file, line_start, line_end, severity, match: { keywords: [...], all?: [...] } }
// extra:    { id, file?, match: { keywords: [...] } }   // a legitimate "unique catch", not a false positive
// truth:    { planted: [planted...], allowed_extras: [extra...] }

const SEVERITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

export function normalizeFile(p) {
  return String(p ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}

function rangesOverlap(aStart, aEnd, bStart, bEnd, tol = 0) {
  if (![aStart, aEnd, bStart, bEnd].every((n) => Number.isInteger(n))) return false;
  return aStart - tol <= bEnd && bStart <= aEnd + tol;
}

function haystack(finding) {
  return `${finding.title ?? ""} ${finding.body ?? ""}`.toLowerCase();
}

// `match.keywords` is any-of: the reviewer's wording for the claim is free.
// `match.all` is every-of: the subject the finding has to actually be about.
//
// The split exists because a wildcard defect (`file: "*"`) is matched on words
// alone, and a subject word is a word every finding about that area writes down.
// `repo-context` listed the bare module name among its any-of keywords, so a
// finding about an unvalidated secret — which mentioned the module only in
// passing — was credited with catching a missing manifest entry. Put the subject
// in `all` and the claim in `keywords`, and a finding has to carry both.
function keywordsHit(finding, keywords, required) {
  const hay = haystack(finding);
  if (Array.isArray(required) && required.length > 0) {
    if (!required.every((k) => hay.includes(String(k).toLowerCase()))) return false;
    // `all` on its own is a complete rule; `keywords` narrows it when present.
    if (!Array.isArray(keywords) || keywords.length === 0) return true;
  } else if (!Array.isArray(keywords) || keywords.length === 0) {
    return false;
  }
  return keywords.some((k) => hay.includes(String(k).toLowerCase()));
}

// Match strength of a finding against a planted defect: 2 = keyword match (strong),
// 1 = line-range overlap only (weak), 0 = no match. Same file is required. Keyword
// is preferred so that two line-adjacent defects are not both credited to one
// finding (the scorer assigns each finding to its single best unmatched planted).
// Default line tolerance is 0: keyword match is the robust signal (every planted
// defect should carry keywords), and an exact line overlap is the fallback for
// keyword-less defects. A loose tolerance would let an adjacent defect's finding
// falsely claim a neighbour, so it stays tight.
function fileMatches(findingFile, declaredFile) {
  // A planted defect may set file to "*" (or omit it) when it spans files and the
  // reviewer could cite any of them — e.g. an undeclared dependency. Then matching
  // is keyword-only.
  if (!declaredFile || declaredFile === "*") return true;
  return normalizeFile(findingFile) === normalizeFile(declaredFile);
}

function matchQuality(finding, planted, lineTolerance) {
  if (!fileMatches(finding.file, planted.file)) return 0;
  if (keywordsHit(finding, planted.match?.keywords, planted.match?.all)) return 2;
  if (planted.file === "*" || !planted.file) return 0; // wildcard defects are keyword-only
  const lineOk = rangesOverlap(
    finding.line_start,
    finding.line_end,
    planted.line_start,
    planted.line_end,
    lineTolerance
  );
  return lineOk ? 1 : 0;
}

export function findingMatchesPlanted(finding, planted, { lineTolerance = 0 } = {}) {
  return matchQuality(finding, planted, lineTolerance) > 0;
}

function findingMatchesExtra(finding, extra) {
  if (extra.file && normalizeFile(finding.file) !== normalizeFile(extra.file)) return false;
  return keywordsHit(finding, extra.match?.keywords, extra.match?.all);
}

function severityCalibration(plantedSeverity, findingSeverity) {
  const expected = SEVERITY_RANK[plantedSeverity];
  const got = SEVERITY_RANK[findingSeverity];
  if (expected == null || got == null) return "unknown";
  const delta = Math.abs(expected - got);
  if (delta === 0) return "exact";
  if (delta === 1) return "within1";
  return "mismatch";
}

// Score one review (findings array) against one case's ground truth.
export function scoreReview(findings, truth, options = {}) {
  const lineTolerance = options.lineTolerance ?? 0;
  const list = Array.isArray(findings) ? findings : [];
  const planted = Array.isArray(truth?.planted) ? truth.planted : [];
  const extras = Array.isArray(truth?.allowed_extras) ? truth.allowed_extras : [];

  const matchedPlantedIds = new Set();
  const severityByPlanted = new Map(); // planted.id -> best finding severity

  let bonus = 0; // legitimate unique catches (allowed_extras)
  let falsePositives = 0;

  for (const finding of list) {
    // Assign this finding to its single best still-unmatched planted defect
    // (keyword match beats line-only), so adjacent defects are not double-counted.
    let best = null;
    let bestQuality = 0;
    for (const p of planted) {
      if (matchedPlantedIds.has(p.id)) continue;
      const q = matchQuality(finding, p, lineTolerance);
      if (q > bestQuality) {
        bestQuality = q;
        best = p;
      }
    }
    if (best) {
      matchedPlantedIds.add(best.id);
      severityByPlanted.set(best.id, finding.severity);
      continue;
    }
    if (extras.some((e) => findingMatchesExtra(finding, e))) {
      bonus += 1;
      continue;
    }
    falsePositives += 1;
  }

  const found = matchedPlantedIds.size;
  const recall = planted.length ? found / planted.length : 1;
  const relevant = found + bonus;
  // Precision over an empty review is not 1, it is undefined, and paying 20 points
  // for it made silence the best available wrong answer: on this corpus, saying
  // nothing scored 20 while naming one thing that turned out to be wrong scored 0.
  // A scorer that rewards not looking cannot be used to argue that looking helps.
  //
  // The exception is real and kept: when there is nothing planted to find, an empty
  // review is the correct answer and earns its precision.
  const precision = list.length ? relevant / list.length : planted.length ? 0 : 1;

  const severity = { exact: 0, within1: 0, mismatch: 0, unknown: 0 };
  for (const p of planted) {
    if (!matchedPlantedIds.has(p.id)) continue;
    severity[severityCalibration(p.severity, severityByPlanted.get(p.id))] += 1;
  }
  const severityExactRate = found ? severity.exact / found : 0;

  // Transparent composite (0–100): recall dominates, precision and severity refine.
  const composite = Math.round(recall * 70 + precision * 20 + severityExactRate * 10);

  return {
    plantedTotal: planted.length,
    found,
    missed: planted.map((p) => p.id).filter((id) => !matchedPlantedIds.has(id)),
    recall: round2(recall),
    precision: round2(precision),
    falsePositives,
    bonus,
    severity,
    severityExactRate: round2(severityExactRate),
    findingsCount: list.length,
    composite
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export const _internal = { SEVERITY_RANK, rangesOverlap, keywordsHit, severityCalibration };
