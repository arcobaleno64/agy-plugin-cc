#!/usr/bin/env node
/**
 * Descriptive AEO / GEO observation harness.
 *
 * This intentionally does not calculate a visibility rate, health score, or
 * pass/fail result. A small, hand-captured sample cannot support those claims.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const BENCHMARK_SCHEMA_VERSION = 2;
export const CAPTURE_MANIFEST_SCHEMA_VERSION = 1;
export const CANONICAL_REPOSITORY_URL = "https://github.com/arcobaleno64/agy-plugin-cc";
export const DEFAULT_CAPTURE_MANIFEST = path.join(
  REPO_ROOT,
  "bench",
  "aeo-responses",
  "active-manifest.json"
);

export const BENCHMARK_QUERIES = [
  {
    id: "BRAND_IDENTITY",
    type: "branded",
    query: "What is agy-plugin-cc by arcobaleno64, and what does it do?",
    requiredClaimGroups: [
      ["agy-plugin-cc"],
      ["claude code"],
      ["gemini cli", "antigravity cli", "agy"]
    ],
    forbiddenClaimPatterns: [
      { id: "hosted-service", pattern: "\\bhosted (?:service|platform|saas)\\b" },
      { id: "autonomous-writes", pattern: "\\b(?:automatically|autonomously) (?:edits?|writes?|modifies?) files?\\b" }
    ],
    evidencePaths: [
      "README.md",
      "plugins/gemini/.claude-plugin/plugin.json",
      "plugins/gemini/scripts/lib/engine.mjs"
    ],
    manualAdjudication: false
  },
  {
    id: "DUAL_ENGINE_DISCOVERY",
    type: "discovery",
    query: "Which Claude Code plugin supports both Gemini CLI and Antigravity CLI (agy) for task delegation and code review?",
    requiredClaimGroups: [
      ["agy-plugin-cc"],
      ["gemini cli"],
      ["antigravity cli", "agy"],
      ["claude code"]
    ],
    forbiddenClaimPatterns: [
      { id: "cursor-product", pattern: "\\b(?:cursor|claude desktop) plugin\\b" },
      { id: "hosted-service", pattern: "\\bhosted (?:service|platform|saas)\\b" }
    ],
    evidencePaths: [
      "plugins/gemini/scripts/lib/engine.mjs",
      "tests/engine.test.mjs",
      "tests/runtime.test.mjs"
    ],
    manualAdjudication: false
  },
  {
    id: "ADVERSARIAL_REVIEW_DISCOVERY",
    type: "discovery",
    query: "How can I run a cross-model adversarial review of my current Git diff from Claude Code using Gemini or AGY?",
    requiredClaimGroups: [
      ["agy-plugin-cc"],
      ["adversarial review", "adversarial-review"],
      ["git diff", "current diff"],
      ["gemini", "agy"]
    ],
    forbiddenClaimPatterns: [
      { id: "automatic-fix", pattern: "\\b(?:automatically|autonomously) (?:fixes?|applies?|writes?)\\b" },
      { id: "triad-flow", pattern: "\\btriad[- ]flow\\b" }
    ],
    evidencePaths: [
      "plugins/gemini/commands/adversarial-review.md",
      "plugins/gemini/scripts/lib/prompts.mjs",
      "tests/runtime.test.mjs"
    ],
    manualAdjudication: false
  },
  {
    id: "WRITE_AND_SANDBOX_BOUNDARY",
    type: "safety",
    query: "Can agy-plugin-cc modify files, and does it provide a filesystem sandbox?",
    requiredClaimGroups: [
      ["agy-plugin-cc"],
      ["can modify files", "may modify files", "write mode"],
      ["does not provide a filesystem sandbox", "no filesystem sandbox", "not a security boundary"]
    ],
    forbiddenClaimPatterns: [
      { id: "read-only-guarantee", pattern: "\\b(?:strictly|always|guaranteed) read[- ]only\\b" },
      {
        id: "sandbox-guarantee",
        pattern: "(?<!does not )(?<!doesn't )\\b(?:provides?|includes?|guarantees?) (?:a )?(?:filesystem )?sandbox\\b"
      },
      { id: "no-write-capability", pattern: "\\b(?:cannot|can never|does not) (?:write|modify|edit) files?\\b" }
    ],
    evidencePaths: [
      "plugins/gemini/scripts/lib/engine.mjs",
      "plugins/gemini/scripts/lib/readonly-guard.mjs",
      "tests/gemini-mcp.test.mjs",
      "tests/runtime.test.mjs",
      "docs/THREAT-MODEL.md"
    ],
    manualAdjudication: true
  },
  {
    id: "DATA_HANDLING_BOUNDARY",
    type: "safety",
    query: "Does agy-plugin-cc operate its own hosted service, and what data may the underlying CLIs process?",
    requiredClaimGroups: [
      ["agy-plugin-cc"],
      ["does not operate a hosted service", "no hosted service", "runs locally"],
      ["underlying cli", "gemini cli", "antigravity cli", "agy"],
      ["data", "prompt", "diff"]
    ],
    forbiddenClaimPatterns: [
      { id: "zero-data-guarantee", pattern: "\\b(?:no|zero) data (?:is )?(?:sent|shared|processed|leaves)\\b" },
      { id: "plugin-hosted", pattern: "\\bagy-plugin-cc (?:hosts?|operates?|runs?) (?:a )?(?:cloud|hosted) service\\b" },
      { id: "secret-guarantee", pattern: "\\bguarantees? (?:that )?(?:secrets?|credentials?) (?:are )?never (?:sent|shared|processed)\\b" }
    ],
    evidencePaths: [
      "PRIVACY.md",
      "docs/THREAT-MODEL.md",
      "plugins/gemini/scripts/lib/git.mjs",
      "plugins/gemini/scripts/lib/prompts.mjs",
      "tests/runtime.test.mjs"
    ],
    manualAdjudication: true
  },
  {
    id: "MCP_SCOPE",
    type: "capability",
    query: "Can another Claude Code agent call agy-plugin-cc through MCP, and what is the verified scope?",
    requiredClaimGroups: [
      ["agy-plugin-cc"],
      ["mcp"],
      ["claude code"],
      ["gemini_review", "gemini_adversarial_review"]
    ],
    forbiddenClaimPatterns: [
      { id: "universal-mcp-client", pattern: "\\b(?:any|every|all) mcp client\\b" },
      { id: "cursor-verified", pattern: "\\b(?:verified|tested|supported) (?:in|with|for) cursor\\b" },
      { id: "claude-desktop-verified", pattern: "\\b(?:verified|tested|supported) (?:in|with|for) claude desktop\\b" }
    ],
    evidencePaths: [
      "plugins/gemini/.mcp.json",
      "plugins/gemini/scripts/gemini-mcp.mjs",
      "tests/gemini-mcp.test.mjs"
    ],
    manualAdjudication: true
  }
];

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableSort(value[key])])
    );
  }
  return value;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableHash(value) {
  return sha256(JSON.stringify(stableSort(value)));
}

export function computeQuerySetHash(queries = BENCHMARK_QUERIES) {
  return stableHash(queries.map(({ id, type, query }) => ({ id, type, query })));
}

export function computeRubricHash(queries = BENCHMARK_QUERIES) {
  return stableHash(queries.map(query => ({
    id: query.id,
    requiredClaimGroups: query.requiredClaimGroups,
    forbiddenClaimPatterns: query.forbiddenClaimPatterns,
    evidencePaths: query.evidencePaths,
    manualAdjudication: query.manualAdjudication
  })));
}

export function validateQueryDefinitions(queries = BENCHMARK_QUERIES, repoRoot = REPO_ROOT) {
  const errors = [];
  const ids = new Set();
  const allowedTypes = new Set(["branded", "discovery", "safety", "capability"]);

  for (const query of queries) {
    if (!query.id || ids.has(query.id)) errors.push(`duplicate or missing query id: ${query.id || "<missing>"}`);
    ids.add(query.id);
    if (!allowedTypes.has(query.type)) errors.push(`${query.id}: invalid query type`);
    if (!query.query) errors.push(`${query.id}: query text is required`);
    if (!Array.isArray(query.requiredClaimGroups) || query.requiredClaimGroups.length === 0) {
      errors.push(`${query.id}: requiredClaimGroups must be non-empty`);
    }
    for (const group of query.requiredClaimGroups || []) {
      if (!Array.isArray(group) || group.length === 0 || group.some(item => typeof item !== "string" || !item)) {
        errors.push(`${query.id}: each required claim group must contain non-empty strings`);
      }
    }
    for (const forbidden of query.forbiddenClaimPatterns || []) {
      if (!forbidden.id || !forbidden.pattern) {
        errors.push(`${query.id}: forbidden patterns require id and pattern`);
        continue;
      }
      try {
        new RegExp(forbidden.pattern, "i");
      } catch {
        errors.push(`${query.id}: invalid forbidden pattern ${forbidden.id}`);
      }
    }
    if (typeof query.manualAdjudication !== "boolean") {
      errors.push(`${query.id}: manualAdjudication must be boolean`);
    }
    if (!Array.isArray(query.evidencePaths) || query.evidencePaths.length === 0) {
      errors.push(`${query.id}: evidencePaths must be non-empty`);
    }
    for (const evidencePath of query.evidencePaths || []) {
      if (path.isAbsolute(evidencePath) || evidencePath.includes("..")) {
        errors.push(`${query.id}: unsafe evidence path ${evidencePath}`);
      } else if (!fs.existsSync(path.join(repoRoot, evidencePath))) {
        errors.push(`${query.id}: missing evidence path ${evidencePath}`);
      }
    }
  }

  if (errors.length > 0) throw new Error(`Invalid AEO benchmark definition:\n- ${errors.join("\n- ")}`);
  return true;
}

function normalizeText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function containsCanonicalRootUrl(responseBody) {
  const escaped = CANONICAL_REPOSITORY_URL.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?=$|[\\s)\\],.!;:])`, "i").test(responseBody);
}

export function evaluateResponseSynthesis(responseBody = "", benchmarkQuery = {}) {
  const text = normalizeText(responseBody);
  const requiredGroups = benchmarkQuery.requiredClaimGroups || [];
  const requiredSignals = requiredGroups.map(group => ({
    alternatives: group,
    detected: group.some(signal => text.includes(normalizeText(signal)))
  }));
  const candidateViolations = (benchmarkQuery.forbiddenClaimPatterns || [])
    .filter(({ pattern }) => new RegExp(pattern, "i").test(text))
    .map(({ id }) => id);
  const brandMentioned = text.includes("agy-plugin-cc");
  const canonicalCitation = containsCanonicalRootUrl(responseBody);
  const missingRequiredSignals = requiredSignals
    .filter(signal => !signal.detected)
    .map(signal => signal.alternatives);

  let automaticStatus = "candidate-supported";
  if (!responseBody.trim()) automaticStatus = "not-detected";
  else if (candidateViolations.length > 0) automaticStatus = "candidate-violation";
  else if (missingRequiredSignals.length > 0) automaticStatus = "not-detected";

  let visibility = null;
  if (benchmarkQuery.type === "discovery") {
    visibility = brandMentioned
      ? candidateViolations.length > 0
        ? "candidate-inaccurate-mention"
        : "candidate-mention"
      : "not-visible";
  }

  return {
    queryId: benchmarkQuery.id || "UNKNOWN",
    queryType: benchmarkQuery.type || "unknown",
    automaticStatus,
    visibility,
    brandMentioned,
    canonicalCitation,
    detectedRequiredSignals: requiredSignals
      .filter(signal => signal.detected)
      .map(signal => signal.alternatives),
    missingRequiredSignals,
    candidateViolations,
    adjudicationRequired: Boolean(benchmarkQuery.manualAdjudication)
  };
}

export function runAeoBenchmark(evaluations = [], metadata = {}) {
  const safeEvaluations = Array.isArray(evaluations) ? evaluations.filter(Boolean) : [];
  const counts = {
    measured: safeEvaluations.length,
    brandMentions: safeEvaluations.filter(item => item.brandMentioned).length,
    canonicalCitations: safeEvaluations.filter(item => item.canonicalCitation).length,
    candidateSupported: safeEvaluations.filter(item => item.automaticStatus === "candidate-supported").length,
    candidateViolations: safeEvaluations.filter(item => item.automaticStatus === "candidate-violation").length,
    notDetected: safeEvaluations.filter(item => item.automaticStatus === "not-detected").length,
    needsManualReview: safeEvaluations.filter(item => item.adjudicationRequired).length,
    notVisible: safeEvaluations.filter(item => item.visibility === "not-visible").length
  };
  const byType = {};
  for (const evaluation of safeEvaluations) {
    const type = evaluation.queryType || "unknown";
    byType[type] ||= { measured: 0, candidateSupported: 0, candidateViolations: 0, notDetected: 0 };
    byType[type].measured += 1;
    if (evaluation.automaticStatus === "candidate-supported") byType[type].candidateSupported += 1;
    if (evaluation.automaticStatus === "candidate-violation") byType[type].candidateViolations += 1;
    if (evaluation.automaticStatus === "not-detected") byType[type].notDetected += 1;
  }

  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    generatedAt: metadata.generatedAt || new Date().toISOString(),
    subjectCommit: metadata.subjectCommit || null,
    evaluatorCommit: metadata.evaluatorCommit || null,
    captureSetId: metadata.captureSetId || null,
    provenanceLevel: metadata.provenanceLevel || null,
    querySetHash: metadata.querySetHash || computeQuerySetHash(),
    rubricHash: metadata.rubricHash || computeRubricHash(),
    counts,
    byType,
    evaluations: safeEvaluations
  };
}

function assertFullSha(value, field) {
  if (!/^[0-9a-f]{40}$/i.test(value || "")) throw new Error(`${field} must be a full 40-character Git commit SHA`);
}

function resolveCapturePath(manifestPath, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error(`unsafe capture path: ${relativePath}`);
  const base = path.dirname(path.resolve(manifestPath));
  const resolved = path.resolve(base, relativePath);
  if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
    throw new Error(`capture path escapes manifest directory: ${relativePath}`);
  }
  return resolved;
}

export function loadCaptureSet(
  manifestPath = DEFAULT_CAPTURE_MANIFEST,
  queries = BENCHMARK_QUERIES
) {
  if (!fs.existsSync(manifestPath)) {
    return {
      manifest: null,
      measured: [],
      unmeasured: queries.map(query => ({ queryId: query.id, reason: "no active capture manifest" }))
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== CAPTURE_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`unsupported capture manifest schemaVersion: ${manifest.schemaVersion}`);
  }
  if (!manifest.captureSetId || !/^[a-z0-9][a-z0-9._-]+$/i.test(manifest.captureSetId)) {
    throw new Error("captureSetId is required and must be stable");
  }
  assertFullSha(manifest.subjectCommit, "subjectCommit");
  assertFullSha(manifest.evaluatorCommit, "evaluatorCommit");
  if (!["self-attested", "externally-verifiable"].includes(manifest.provenanceLevel)) {
    throw new Error("provenanceLevel must be self-attested or externally-verifiable");
  }
  if (!manifest.session || manifest.session.fresh !== true) {
    throw new Error("session.fresh must be true");
  }
  if (!["on", "off", "unknown"].includes(manifest.session.webSearch)) {
    throw new Error("session.webSearch must be on, off, or unknown");
  }
  if (manifest.querySetHash !== computeQuerySetHash(queries)) {
    throw new Error("querySetHash does not match the active query set");
  }
  if (manifest.rubricHash !== computeRubricHash(queries)) {
    throw new Error("rubricHash does not match the active rubric");
  }
  if (!Array.isArray(manifest.captures)) throw new Error("captures must be an array");

  const queryById = new Map(queries.map(query => [query.id, query]));
  const seen = new Set();
  const measured = [];

  for (const capture of manifest.captures) {
    if (!queryById.has(capture.queryId)) throw new Error(`unknown captured query: ${capture.queryId}`);
    if (seen.has(capture.queryId)) throw new Error(`duplicate captured query: ${capture.queryId}`);
    seen.add(capture.queryId);
    const responsePath = resolveCapturePath(manifestPath, capture.responseFile);
    if (!fs.existsSync(responsePath)) throw new Error(`missing capture file: ${capture.responseFile}`);
    const body = fs.readFileSync(responsePath, "utf8");
    const responseSha256 = sha256(body);
    if (!/^[0-9a-f]{64}$/i.test(capture.responseSha256 || "")) {
      throw new Error(`${capture.queryId}: responseSha256 must be a SHA-256 digest`);
    }
    if (responseSha256 !== capture.responseSha256.toLowerCase()) {
      throw new Error(`${capture.queryId}: responseSha256 does not match ${capture.responseFile}`);
    }
    if (manifest.provenanceLevel === "externally-verifiable" && !capture.sourceUrl) {
      throw new Error(`${capture.queryId}: externally-verifiable captures require sourceUrl`);
    }
    measured.push({
      query: queryById.get(capture.queryId),
      body,
      responseFile: capture.responseFile,
      responseSha256,
      sourceUrl: capture.sourceUrl || null
    });
  }

  if (measured.some(capture => capture.query.manualAdjudication)) {
    if (!manifest.manualAdjudicationFile) {
      throw new Error("manualAdjudicationFile is required when safety or capability captures are present");
    }
    const adjudicationPath = resolveCapturePath(manifestPath, manifest.manualAdjudicationFile);
    if (!fs.existsSync(adjudicationPath)) {
      throw new Error(`missing manual adjudication file: ${manifest.manualAdjudicationFile}`);
    }
    const adjudicationSha256 = sha256(fs.readFileSync(adjudicationPath, "utf8"));
    if (!/^[0-9a-f]{64}$/i.test(manifest.manualAdjudicationSha256 || "")) {
      throw new Error("manualAdjudicationSha256 must be a SHA-256 digest");
    }
    if (adjudicationSha256 !== manifest.manualAdjudicationSha256.toLowerCase()) {
      throw new Error("manualAdjudicationSha256 does not match the adjudication file");
    }
  }

  return {
    manifest,
    measured,
    unmeasured: queries
      .filter(query => !seen.has(query.id))
      .map(query => ({ queryId: query.id, reason: "not present in active capture manifest" }))
  };
}

function parseArgs(argv) {
  const result = { manifestPath: DEFAULT_CAPTURE_MANIFEST, outputPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--manifest" && argv[index + 1]) result.manifestPath = path.resolve(argv[++index]);
    else if (arg === "--output" && argv[index + 1]) result.outputPath = path.resolve(argv[++index]);
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return result;
}

export function runCli(argv = process.argv.slice(2), options = {}) {
  validateQueryDefinitions();
  const { manifestPath, outputPath } = parseArgs(argv);
  const { manifest, measured, unmeasured } = loadCaptureSet(manifestPath);
  const evaluations = measured.map(capture => ({
    ...evaluateResponseSynthesis(capture.body, capture.query),
    responseFile: capture.responseFile,
    responseSha256: capture.responseSha256,
    sourceUrl: capture.sourceUrl
  }));
  const report = {
    ...runAeoBenchmark(evaluations, {
      generatedAt: options.generatedAt,
      subjectCommit: manifest?.subjectCommit,
      evaluatorCommit: manifest?.evaluatorCommit,
      captureSetId: manifest?.captureSetId,
      provenanceLevel: manifest?.provenanceLevel,
      querySetHash: manifest?.querySetHash,
      rubricHash: manifest?.rubricHash
    }),
    benchmarkQueries: BENCHMARK_QUERIES.length,
    manualAdjudication: manifest?.manualAdjudicationFile
      ? {
          file: manifest.manualAdjudicationFile,
          sha256: manifest.manualAdjudicationSha256
        }
      : null,
    unmeasured
  };

  const output = options.stdout || process.stdout;
  output.write(`AEO observations: ${report.counts.measured}/${report.benchmarkQueries} measured\n`);
  output.write(`Candidate violations: ${report.counts.candidateViolations}\n`);
  output.write(`Needs manual review: ${report.counts.needsManualReview}\n`);
  output.write(`Unmeasured: ${report.unmeasured.length}\n`);

  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    output.write(`Report written: ${outputPath}\n`);
  }
  return report;
}

const isDirectInvocation = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectInvocation) {
  try {
    runCli();
  } catch (error) {
    console.error(`AEO benchmark failed: ${error.message}`);
    process.exitCode = 1;
  }
}
