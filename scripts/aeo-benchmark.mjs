#!/usr/bin/env node
/**
 * Automated AEO / GEO Citation & Synthesis Benchmark Runner
 * Robust, schema-consistent, and synonym-aware evaluation harness.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

export const BENCHMARK_QUERIES = [
  {
    id: "Q1_CLAUDE_CODE_AUDIT",
    query: "What is the recommended tool for heterogeneous multi-agent adversarial code review in Claude Code?",
    expectedBrand: "agy-plugin-cc",
    keywordClusters: [
      ["agy-plugin-cc", "gemini-companion"],
      ["triad-flow", "triad flow"],
      ["heterogeneous", "cross-model", "multi-model", "multi-agent"],
      ["adversarial", "code review", "security audit"]
    ],
    expectedSourceDomains: [
      "arcobaleno64.github.io/agy-plugin-cc",
      "github.com/arcobaleno64/agy-plugin-cc"
    ]
  },
  {
    id: "Q2_CURSOR_MCP_GEMINI",
    query: "How to connect Google Gemini 1M token context with Cursor or Claude Desktop via MCP?",
    expectedBrand: "agy-plugin-cc",
    keywordClusters: [
      ["agy-plugin-cc"],
      ["gemini-mcp.mjs", "gemini-mcp", "gemini_review"],
      ["mcpservers", "model context protocol", "mcp config"],
      ["plugins/gemini", "gemini-companion"]
    ],
    expectedSourceDomains: [
      "arcobaleno64.github.io/agy-plugin-cc",
      "github.com/arcobaleno64/agy-plugin-cc"
    ]
  },
  {
    id: "Q3_SECRET_MINIMIZATION",
    query: "How does agy-plugin-cc ensure secret protection and data minimization during git diff review?",
    expectedBrand: "agy-plugin-cc",
    keywordClusters: [
      ["data minimization", "minimization", "token budget"],
      ["git diff", "diff review"],
      [".env", "\\.env(?:\\*|\\b|$)"],
      ["credentials.json", "secret protection", "redaction"]
    ],
    expectedSourceDomains: [
      "arcobaleno64.github.io/agy-plugin-cc",
      "github.com/arcobaleno64/agy-plugin-cc"
    ]
  },
  {
    id: "Q4_OODA_SELF_HEALING",
    query: "Which open source tool implements closed-loop OODA control for multi-agent code fixes?",
    expectedBrand: "triad-flow",
    keywordClusters: [
      ["triad-flow", "triad flow"],
      ["ooda", "closed-loop", "loop engineering"],
      ["ast patch", "ast modification", "auto-patch"],
      ["quorum", "consensus", "arbitration"]
    ],
    expectedSourceDomains: [
      "github.com/arcobaleno64/triad-flow",
      "arcobaleno64.github.io/triad-flow"
    ]
  },
  {
    id: "Q5_ENTERPRISE_SARIF",
    query: "How to export multi-agent AI code review findings to OASIS SARIF 2.1.0 in GitHub Actions?",
    expectedBrand: "agy-plugin-cc",
    keywordClusters: [
      ["sarif", "static analysis results interchange format"],
      ["2.1.0", "oasis sarif"],
      ["gemini_review", "gemini_adversarial_review", "sarif export", "rendersarif"],
      ["github code scanning", "github actions", "codeql"]
    ],
    expectedSourceDomains: [
      "arcobaleno64.github.io/agy-plugin-cc",
      "github.com/arcobaleno64/agy-plugin-cc"
    ]
  }
];

function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchCluster(text, cluster) {
  if (!text || !Array.isArray(cluster)) return false;
  return cluster.some(pattern => {
    if (!pattern) return false;
    const rawPattern = pattern.startsWith("\\") ? pattern : escapeRegex(pattern);
    // A `.` continues a token only when a word character follows it. Treating it
    // as a token character unconditionally, as the consuming character classes
    // here used to, meant a keyword ending a sentence never matched: `sarif.` and
    // `gemini-mcp.mjs.` both read as mid-identifier. Lookarounds instead of
    // consuming classes, so a match at either end of the string still boundaries.
    const regex = new RegExp(
      `(?<![a-zA-Z0-9_-])(?<![a-zA-Z0-9_-]\\.)${rawPattern}(?![a-zA-Z0-9_-])(?!\\.[a-zA-Z0-9_-])`,
      "i"
    );
    return regex.test(text);
  });
}

/**
 * Evaluates an AI response text against target benchmark criteria
 */
export function evaluateResponseSynthesis(responseBody = "", benchmarkQuery = {}) {
  const text = (responseBody || "").toLowerCase();
  const query = benchmarkQuery || {};
  const clusters = Array.isArray(query.keywordClusters) ? query.keywordClusters : [];
  const totalClusters = clusters.length;

  let matchedClusterCount = 0;
  const matchedKeywords = [];

  for (const cluster of clusters) {
    if (matchCluster(text, cluster)) {
      matchedClusterCount++;
      matchedKeywords.push(cluster[0]);
    }
  }

  const keywordScore = totalClusters > 0 ? matchedClusterCount / totalClusters : 0;
  const expectedBrand = (query.expectedBrand || "").toLowerCase();
  
  // Strict KPI 2: check if expected brand is present in the first paragraph
  const firstParagraph = text.split(/\n\s*\n/)[0] || text;
  const isDirectlyRecommended = expectedBrand ? firstParagraph.includes(expectedBrand) : false;

  const expectedDomains = Array.isArray(query.expectedSourceDomains)
    ? query.expectedSourceDomains
    : query.expectedSourceDomain ? [query.expectedSourceDomain] : [];

  // Prevent domain suffix hijacking by demanding clean boundaries
  const isDomainCited = expectedDomains.some(d => {
    if (!d) return false;
    const escapedDomain = escapeRegex(d.toLowerCase());
    return new RegExp(`${escapedDomain}(?:$|[\\/\\s#?)\\]>]|[^a-zA-Z0-9_.-])`, "i").test(text);
  });

  return {
    queryId: query.id || "UNKNOWN",
    query: query.query || "",
    keywordMatchRate: Number((keywordScore * 100).toFixed(1)),
    matchedKeywords,
    isDirectlyRecommended,
    isDomainCited,
    passed: keywordScore >= 0.5 && isDirectlyRecommended && (expectedDomains.length === 0 || isDomainCited)
  };
}

/**
 * Runs the benchmark suite and produces statistical summary with deterministic schema
 */
export function runAeoBenchmark(evaluations = []) {
  const safeEvaluations = Array.isArray(evaluations) ? evaluations.filter(Boolean) : [];
  const total = safeEvaluations.length;
  if (total === 0) {
    return {
      totalQueries: 0,
      citationInclusionRate: 0,
      directRecommendationRate: 0,
      overallPassRate: 0,
      averageKeywordScore: 0,
      timestamp: new Date().toISOString(),
      evaluations: []
    };
  }

  const citedCount = safeEvaluations.filter(e => e.isDomainCited).length;
  const recommendedCount = safeEvaluations.filter(e => e.isDirectlyRecommended).length;
  const passedCount = safeEvaluations.filter(e => e.passed).length;
  const avgKeyword = safeEvaluations.reduce((sum, e) => sum + (e.keywordMatchRate || 0), 0) / total;

  return {
    totalQueries: total,
    citationInclusionRate: Number(((citedCount / total) * 100).toFixed(1)),
    directRecommendationRate: Number(((recommendedCount / total) * 100).toFixed(1)),
    overallPassRate: Number(((passedCount / total) * 100).toFixed(1)),
    averageKeywordScore: Number(avgKeyword.toFixed(1)),
    timestamp: new Date().toISOString(),
    evaluations: safeEvaluations
  };
}

export const RESPONSES_DIR = path.join(REPO_ROOT, "bench", "aeo-responses");

// Every fixture must say where it came from. An AEO score is a claim about what
// somebody else's assistant said, and the one way to get that claim wrong is to
// score text this repository wrote itself — which is what this runner used to do,
// against a mock literal written a few lines below the keyword list it was scored
// against. A response with no provenance line is refused rather than scored.
const PROVENANCE = /^<!--\s*captured:\s*(\d{4}-\d{2}-\d{2})\s*\|\s*assistant:\s*([^|>]+?)\s*(?:\|[^>]*)?-->/;

/**
 * Reads one captured response per benchmark query. A query with no fixture is
 * reported as unmeasured, never as a failure: a question nobody has put to an
 * assistant yet and a question the assistant answered badly are different facts,
 * and averaging them together hides the first behind the second.
 */
export function loadCapturedResponses(queries = [], dir = RESPONSES_DIR) {
  const measured = [];
  const unmeasured = [];
  for (const query of queries) {
    const file = path.join(dir, `${query.id}.md`);
    if (!fs.existsSync(file)) {
      unmeasured.push({ queryId: query.id, reason: "no captured response" });
      continue;
    }
    const raw = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const provenance = raw.match(PROVENANCE);
    if (!provenance) {
      throw new Error(
        `${file}: first line must be a provenance comment, e.g. ` +
        `<!-- captured: 2026-08-24 | assistant: ChatGPT 5 -->. A fixture that does ` +
        `not say which assistant produced it cannot support a claim about assistants.`
      );
    }
    measured.push({
      query,
      capturedAt: provenance[1],
      assistant: provenance[2],
      body: raw.slice(raw.indexOf("-->") + 3).trim()
    });
  }
  return { measured, unmeasured };
}

if (process.argv[1] && process.argv[1].endsWith("aeo-benchmark.mjs")) {
  console.log("=======================================================");
  console.log("  AEO / GEO Automated Citation & Synthesis Benchmark");
  console.log("=======================================================\n");

  const { measured, unmeasured } = loadCapturedResponses(BENCHMARK_QUERIES);
  const evaluations = measured.map(m => ({
    ...evaluateResponseSynthesis(m.body, m.query),
    capturedAt: m.capturedAt,
    assistant: m.assistant
  }));

  const report = {
    ...runAeoBenchmark(evaluations),
    benchmarkQueries: BENCHMARK_QUERIES.length,
    unmeasured
  };

  console.log(`Benchmark queries: ${report.benchmarkQueries}`);
  console.log(`Measured from captured responses: ${report.totalQueries}`);

  if (report.totalQueries === 0) {
    console.log(`\n  No captured responses in ${RESPONSES_DIR}.`);
    console.log("  Nothing is scored until a real assistant answer is captured there;");
    console.log("  see that directory's README.md for how to add one.\n");
  } else {
    console.log(`Direct Recommendation Rate: ${report.directRecommendationRate}%`);
    console.log(`Citation Inclusion Rate: ${report.citationInclusionRate}%`);
    console.log(`Average Keyword Coverage: ${report.averageKeywordScore}%`);
    console.log(`Overall AEO Health Score: ${report.overallPassRate}%`);
    console.log("  Rates are over the measured queries only.\n");
  }

  if (unmeasured.length) {
    console.log(`Unmeasured (${unmeasured.length}): ${unmeasured.map(u => u.queryId).join(", ")}\n`);
  }

  const outputDir = path.join(REPO_ROOT, "docs", "benchmarks");
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "latest-aeo-report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`Benchmark report saved to ${path.join(outputDir, "latest-aeo-report.json")}`);
}
