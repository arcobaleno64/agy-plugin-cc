import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  BENCHMARK_QUERIES,
  CANONICAL_REPOSITORY_URL,
  computeQuerySetHash,
  computeRubricHash,
  evaluateResponseSynthesis,
  loadCaptureSet,
  runAeoBenchmark,
  runCli,
  validateQueryDefinitions
} from "../scripts/aeo-benchmark.mjs";

function query(id) {
  return BENCHMARK_QUERIES.find(item => item.id === id);
}

function digest(body) {
  return crypto.createHash("sha256").update(body).digest("hex");
}

function captureFixture({
  queryIds = [BENCHMARK_QUERIES[0].id],
  querySetHash = computeQuerySetHash(),
  rubricHash = computeRubricHash(),
  provenanceLevel = "self-attested"
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeo-captures-"));
  const captures = queryIds.map(queryId => {
    const body = `agy-plugin-cc is a Claude Code plugin using Gemini CLI. ${CANONICAL_REPOSITORY_URL}\n`;
    const responseFile = `${queryId}.md`;
    fs.writeFileSync(path.join(dir, responseFile), body, "utf8");
    return {
      queryId,
      responseFile,
      responseSha256: digest(body),
      ...(provenanceLevel === "externally-verifiable"
        ? { sourceUrl: `https://example.com/captures/${queryId}` }
        : {})
    };
  });
  const manifest = {
    schemaVersion: 1,
    captureSetId: "2026-08-29-fresh-chatgpt",
    subjectCommit: "1".repeat(40),
    evaluatorCommit: "2".repeat(40),
    provenanceLevel,
    assistant: "ChatGPT",
    capturedAt: "2026-08-29",
    session: { fresh: true, webSearch: "off" },
    querySetHash,
    rubricHash,
    captures
  };
  const manifestPath = path.join(dir, "active-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { dir, manifest, manifestPath };
}

function writableBuffer() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      }
    }),
    read: () => value
  };
}

test("the minimal query set is valid, evidence-backed, and excludes legacy scope", () => {
  assert.equal(validateQueryDefinitions(), true);
  assert.equal(BENCHMARK_QUERIES.length, 6);
  assert.deepEqual(
    BENCHMARK_QUERIES.map(item => item.id),
    [
      "BRAND_IDENTITY",
      "DUAL_ENGINE_DISCOVERY",
      "ADVERSARIAL_REVIEW_DISCOVERY",
      "WRITE_AND_SANDBOX_BOUNDARY",
      "DATA_HANDLING_BOUNDARY",
      "MCP_SCOPE"
    ]
  );
  const measuredScope = JSON.stringify(BENCHMARK_QUERIES.map(item => ({
    query: item.query,
    requiredClaimGroups: item.requiredClaimGroups
  })));
  assert.doesNotMatch(measuredScope, /triad.flow|ooda|sarif|claude desktop|1m token/i);
  for (const item of BENCHMARK_QUERIES) {
    assert.ok(item.evidencePaths.length > 0);
  }
});

test("query and rubric hashes separate the observed question from its evaluator", () => {
  const changedQuestion = structuredClone(BENCHMARK_QUERIES);
  changedQuestion[0].query += " Please be concise.";
  assert.notEqual(computeQuerySetHash(changedQuestion), computeQuerySetHash());
  assert.equal(computeRubricHash(changedQuestion), computeRubricHash());

  const changedRubric = structuredClone(BENCHMARK_QUERIES);
  changedRubric[0].requiredClaimGroups.push(["open source"]);
  assert.equal(computeQuerySetHash(changedRubric), computeQuerySetHash());
  assert.notEqual(computeRubricHash(changedRubric), computeRubricHash());
});

test("discovery observations distinguish invisibility from inaccurate mentions", () => {
  const target = query("DUAL_ENGINE_DISCOVERY");
  const absent = evaluateResponseSynthesis("Try a generic multi-model integration.", target);
  assert.equal(absent.visibility, "not-visible");
  assert.equal(absent.automaticStatus, "not-detected");

  const inaccurate = evaluateResponseSynthesis(
    "agy-plugin-cc is a Cursor plugin for Gemini CLI and Antigravity CLI (agy), not Claude Code.",
    target
  );
  assert.equal(inaccurate.visibility, "candidate-inaccurate-mention");
  assert.equal(inaccurate.automaticStatus, "candidate-violation");
});

test("only the canonical repository root is counted as a canonical citation", () => {
  const target = query("BRAND_IDENTITY");
  const base = "agy-plugin-cc is a Claude Code plugin for Gemini CLI.";
  assert.equal(
    evaluateResponseSynthesis(`${base} ${CANONICAL_REPOSITORY_URL}`, target).canonicalCitation,
    true
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} https://github.com/arcobaleno64/agy-plugin-cc/issues/121`, target).canonicalCitation,
    false,
    "subpaths do not prove that the canonical root itself was cited"
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} https://github.com/someone/agy-plugin-cc`, target).canonicalCitation,
    false
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} https://github.com/arcobaleno64/gemini-plugin-cc`, target).canonicalCitation,
    false
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} https://github.com/arcobaleno64/agy-plugin-cc-fork`, target).canonicalCitation,
    false
  );
});

test("safety regexes produce candidates and still require manual adjudication", () => {
  const target = query("WRITE_AND_SANDBOX_BOUNDARY");
  const accurate = evaluateResponseSynthesis(
    "agy-plugin-cc can modify files in write mode. It does not provide a filesystem sandbox and is not a security boundary.",
    target
  );
  assert.equal(accurate.automaticStatus, "candidate-supported");
  assert.equal(accurate.adjudicationRequired, true);

  const unsafe = evaluateResponseSynthesis(
    "agy-plugin-cc is guaranteed read-only and provides a filesystem sandbox.",
    target
  );
  assert.equal(unsafe.automaticStatus, "candidate-violation");
  assert.deepEqual(unsafe.candidateViolations.sort(), ["read-only-guarantee", "sandbox-guarantee"]);
  assert.equal(unsafe.adjudicationRequired, true);
});

test("candidate violations are never converted into an automatic pass", () => {
  const target = query("MCP_SCOPE");
  const evaluation = evaluateResponseSynthesis(
    "agy-plugin-cc supports MCP in Claude Code via gemini_review, and is verified in Cursor for any MCP client.",
    target
  );
  assert.equal(evaluation.automaticStatus, "candidate-violation");
  assert.deepEqual(evaluation.candidateViolations.sort(), ["cursor-verified", "universal-mcp-client"]);
  assert.equal(evaluation.adjudicationRequired, true);
});

test("reports contain descriptive counts, not rates, scores, or causal claims", () => {
  const report = runAeoBenchmark([
    evaluateResponseSynthesis(
      "agy-plugin-cc is a Claude Code plugin for Gemini CLI. " + CANONICAL_REPOSITORY_URL,
      query("BRAND_IDENTITY")
    )
  ], { generatedAt: "2026-08-29T00:00:00.000Z" });

  assert.equal(report.counts.measured, 1);
  assert.equal(report.counts.brandMentions, 1);
  assert.equal(report.generatedAt, "2026-08-29T00:00:00.000Z");
  const keys = [];
  const visit = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      keys.push(key);
      visit(nested);
    }
  };
  visit(report);
  assert.equal(keys.some(key => /(?:Rate|Score)$/i.test(key)), false);
  assert.equal("overallHealth" in report, false);
});

test("a valid explicit manifest loads only exact, hash-verified captures", () => {
  const fixture = captureFixture({ queryIds: [BENCHMARK_QUERIES[0].id, BENCHMARK_QUERIES[1].id] });
  const loaded = loadCaptureSet(fixture.manifestPath);
  assert.equal(loaded.measured.length, 2);
  assert.equal(loaded.unmeasured.length, 4);
  assert.equal(loaded.manifest.provenanceLevel, "self-attested");
});

test("missing manifests are unmeasured rather than failures", () => {
  const missing = path.join(os.tmpdir(), `missing-aeo-${crypto.randomUUID()}.json`);
  const loaded = loadCaptureSet(missing);
  assert.equal(loaded.measured.length, 0);
  assert.equal(loaded.unmeasured.length, BENCHMARK_QUERIES.length);
});

test("manifest query and rubric drift are rejected", () => {
  const queryDrift = captureFixture({ querySetHash: "0".repeat(64) });
  assert.throws(() => loadCaptureSet(queryDrift.manifestPath), /querySetHash/);

  const rubricDrift = captureFixture({ rubricHash: "0".repeat(64) });
  assert.throws(() => loadCaptureSet(rubricDrift.manifestPath), /rubricHash/);
});

test("capture tampering, duplicate queries, and path escapes are rejected", () => {
  const tampered = captureFixture();
  fs.appendFileSync(path.join(tampered.dir, tampered.manifest.captures[0].responseFile), "tampered");
  assert.throws(() => loadCaptureSet(tampered.manifestPath), /responseSha256 does not match/);

  const duplicate = captureFixture();
  duplicate.manifest.captures.push({ ...duplicate.manifest.captures[0] });
  fs.writeFileSync(duplicate.manifestPath, JSON.stringify(duplicate.manifest), "utf8");
  assert.throws(() => loadCaptureSet(duplicate.manifestPath), /duplicate captured query/);

  const escaped = captureFixture();
  escaped.manifest.captures[0].responseFile = "../outside.md";
  fs.writeFileSync(escaped.manifestPath, JSON.stringify(escaped.manifest), "utf8");
  assert.throws(() => loadCaptureSet(escaped.manifestPath), /escapes manifest directory/);
});

test("externally-verifiable provenance requires an immutable source URL per capture", () => {
  const fixture = captureFixture({ provenanceLevel: "externally-verifiable" });
  delete fixture.manifest.captures[0].sourceUrl;
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /require sourceUrl/);
});

test("safety and capability captures require a hash-verified manual adjudication", () => {
  const fixture = captureFixture({ queryIds: ["WRITE_AND_SANDBOX_BOUNDARY"] });
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /manualAdjudicationFile is required/);

  const adjudication = "Status: not-detected\nChecked against runtime evidence.\n";
  fs.writeFileSync(path.join(fixture.dir, "manual.md"), adjudication, "utf8");
  fixture.manifest.manualAdjudicationFile = "manual.md";
  fixture.manifest.manualAdjudicationSha256 = digest(adjudication);
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
  assert.equal(loadCaptureSet(fixture.manifestPath).measured.length, 1);

  fixture.manifest.manualAdjudicationSha256 = "0".repeat(64);
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest), "utf8");
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /does not match the adjudication file/);
});

test("the CLI is read-only by default and writes only to an explicit output path", () => {
  const fixture = captureFixture();
  const stdout = writableBuffer();
  const report = runCli(["--manifest", fixture.manifestPath], {
    generatedAt: "2026-08-29T00:00:00.000Z",
    stdout: stdout.stream
  });
  assert.equal(report.counts.measured, 1);
  assert.match(stdout.read(), /AEO observations: 1\/6 measured/);
  assert.deepEqual(fs.readdirSync(fixture.dir).sort(), [
    "BRAND_IDENTITY.md",
    "active-manifest.json"
  ]);

  const outputPath = path.join(fixture.dir, "reports", "report.json");
  runCli(["--manifest", fixture.manifestPath, "--output", outputPath], {
    generatedAt: "2026-08-29T00:00:00.000Z",
    stdout: writableBuffer().stream
  });
  const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(written.generatedAt, "2026-08-29T00:00:00.000Z");
  assert.equal(written.counts.measured, 1);
});

test("unknown CLI arguments fail closed", () => {
  assert.throws(() => runCli(["--latest"]), /unknown or incomplete argument/);
});
