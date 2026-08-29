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
  provenanceLevel = "self-attested",
  responses = {}
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeo-captures-"));
  const captures = queryIds.map(queryId => {
    const body = responses[queryId]
      || `agy-plugin-cc by arcobaleno64 is a Claude Code plugin using Gemini CLI and Antigravity CLI. ${CANONICAL_REPOSITORY_URL}\n`;
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
    surface: "ChatGPT",
    capturedAt: "2026-08-29T00:00:00Z",
    captureMethod: "Each query was submitted independently and the complete response was saved verbatim.",
    resultPolicy: "One complete response per query.",
    session: { fresh: true, webSearch: "off" },
    querySetHash,
    rubricHash,
    captures
  };
  const manifestPath = path.join(dir, "active-manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { dir, manifest, manifestPath };
}

function writeManifest(fixture) {
  fs.writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
}

function addManualAdjudication(fixture, queryIds, overrides = {}) {
  const adjudication = {
    schemaVersion: 1,
    subjectCommit: fixture.manifest.subjectCommit,
    reviewedAt: "2026-08-29T00:30:00Z",
    adjudications: queryIds.map(queryId => ({
      queryId,
      status: "not-detected",
      rationale: "The captured response does not establish the required canonical-project claims.",
      evidencePaths: BENCHMARK_QUERIES.find(item => item.id === queryId).evidencePaths,
      ...overrides[queryId]
    }))
  };
  const body = `${JSON.stringify(adjudication, null, 2)}\n`;
  fixture.manifest.manualAdjudicationFile = "manual-adjudication.json";
  fixture.manifest.manualAdjudicationSha256 = digest(body);
  fs.writeFileSync(path.join(fixture.dir, fixture.manifest.manualAdjudicationFile), body, "utf8");
  writeManifest(fixture);
  return adjudication;
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

test("a project-name substring cannot satisfy the separate AGY engine claim", () => {
  const target = query("DUAL_ENGINE_DISCOVERY");
  const result = evaluateResponseSynthesis(
    "agy-plugin-cc by arcobaleno64 is a Claude Code plugin using Gemini CLI.",
    target
  );
  assert.equal(result.automaticStatus, "not-detected");
  assert.deepEqual(result.missingRequiredSignals, [["antigravity cli", "agy"]]);
});

test("negated required claims are ambiguous rather than candidate-supported", () => {
  const target = query("DUAL_ENGINE_DISCOVERY");
  const result = evaluateResponseSynthesis(
    "agy-plugin-cc by arcobaleno64 is not a Claude Code plugin and does not support Gemini CLI or Antigravity CLI (agy).",
    target
  );
  assert.equal(result.automaticStatus, "candidate-ambiguous");
  assert.equal(result.adjudicationRequired, true);
  assert.ok(result.ambiguousRequiredSignals.length > 0);
});

test("accurate negations do not become unsupported-claim violations", () => {
  const cases = [
    ["ADVERSARIAL_REVIEW_DISCOVERY", "agy-plugin-cc by arcobaleno64 supports adversarial review of the current git diff with Gemini, and it does not use triad-flow."],
    ["WRITE_AND_SANDBOX_BOUNDARY", "agy-plugin-cc by arcobaleno64 can modify files in write mode. It is not guaranteed read-only and does not itself provide a filesystem sandbox."],
    ["DATA_HANDLING_BOUNDARY", "agy-plugin-cc by arcobaleno64 runs locally with an underlying Gemini CLI that may process prompt data. It does not guarantee that secrets are never sent."]
  ];
  for (const [queryId, body] of cases) {
    assert.deepEqual(
      evaluateResponseSynthesis(body, query(queryId)).candidateViolations,
      [],
      queryId
    );
  }
});

test("not-only constructions remain affirmative unsupported-claim candidates", () => {
  const result = evaluateResponseSynthesis(
    "agy-plugin-cc by arcobaleno64 supports adversarial review of the current git diff with Gemini and not only automatically fixes the code but also publishes it.",
    query("ADVERSARIAL_REVIEW_DISCOVERY")
  );
  assert.deepEqual(result.candidateViolations, ["automatic-fix"]);
  assert.equal(result.automaticStatus, "candidate-violation");
});

test("negation does not leak across clause punctuation", () => {
  for (const separator of [";", ",", ":"]) {
    const result = evaluateResponseSynthesis(
      `agy-plugin-cc by arcobaleno64 supports adversarial review of the current git diff with Gemini. It does not use triad-flow${separator} automatically fixes code.`,
      query("ADVERSARIAL_REVIEW_DISCOVERY")
    );
    assert.deepEqual(result.candidateViolations, ["automatic-fix"], separator);
    assert.equal(result.automaticStatus, "candidate-violation", separator);
  }
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
  assert.equal(
    evaluateResponseSynthesis(`${base} not${CANONICAL_REPOSITORY_URL}`, target).canonicalCitation,
    false
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} https://evil.example/${CANONICAL_REPOSITORY_URL}`, target).canonicalCitation,
    false
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} [${CANONICAL_REPOSITORY_URL}](https://evil.example)`, target).canonicalCitation,
    false
  );
  assert.equal(
    evaluateResponseSynthesis(`${base} [canonical repository](${CANONICAL_REPOSITORY_URL}/)`, target).canonicalCitation,
    true
  );
});

test("same-name repositories are recorded as collisions, not canonical visibility", () => {
  const target = query("DUAL_ENGINE_DISCOVERY");
  const result = evaluateResponseSynthesis(
    "jakeryderv/agy-plugin-cc supports Claude Code, Gemini CLI, and Antigravity CLI (agy). https://github.com/jakeryderv/agy-plugin-cc",
    target
  );
  assert.equal(result.nameMentioned, true);
  assert.equal(result.canonicalProjectMentioned, false);
  assert.equal(result.identityCollisionCandidate, true);
  assert.equal(result.visibility, "not-visible");
  assert.equal(result.automaticStatus, "not-detected");

  for (const conflictingUrl of [
    "https://github.com/jakeryderv/agy-plugin-cc/issues/1",
    "https://github.com/jakeryderv/agy-plugin-cc.git"
  ]) {
    const nested = evaluateResponseSynthesis(
      `agy-plugin-cc supports Claude Code, Gemini CLI, and Antigravity CLI (agy). ${conflictingUrl}`,
      target
    );
    assert.equal(nested.identityCollisionCandidate, true, conflictingUrl);
    assert.equal(nested.visibility, "not-visible", conflictingUrl);
    assert.equal(nested.automaticStatus, "not-detected", conflictingUrl);
  }
});

test("canonical project identity requires the actual repository-root URL", () => {
  const target = query("BRAND_IDENTITY");
  for (const spoof of [
    "https://evil.example/arcobaleno64/agy-plugin-cc",
    "[arcobaleno64/agy-plugin-cc](https://evil.example/repo)",
    "[arcobaleno64/agy-plugin-cc](<https://evil.example/repo>)",
    "[arcobaleno64/agy-plugin-cc](https://evil.example/repo \"fake canonical\")",
    "[arcobaleno64/agy-plugin-cc][evil]\n[evil]: https://evil.example/repo",
    "[source [arcobaleno64/agy-plugin-cc]](https://evil.example/repo)",
    "agy-plugin-cc by arcobaleno64"
  ]) {
    const result = evaluateResponseSynthesis(
      `agy-plugin-cc is a Claude Code plugin for Gemini CLI and Antigravity CLI. ${spoof}`,
      target
    );
    assert.equal(result.canonicalProjectMentioned, false, spoof);
    assert.equal(result.canonicalCitation, false, spoof);
  }

  const canonical = evaluateResponseSynthesis(
    `agy-plugin-cc by arcobaleno64 is a Claude Code plugin for Gemini CLI and Antigravity CLI. ${CANONICAL_REPOSITORY_URL}`,
    target
  );
  assert.equal(canonical.canonicalProjectMentioned, true);
  assert.equal(canonical.canonicalCitation, true);
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
  assert.equal(report.counts.nameMentions, 1);
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

  const reused = captureFixture({ queryIds: ["BRAND_IDENTITY", "DUAL_ENGINE_DISCOVERY"] });
  reused.manifest.captures[1].responseFile = reused.manifest.captures[0].responseFile;
  reused.manifest.captures[1].responseSha256 = reused.manifest.captures[0].responseSha256;
  writeManifest(reused);
  assert.throws(() => loadCaptureSet(reused.manifestPath), /reused capture file/);

  if (process.platform !== "win32") {
    const hardlinked = captureFixture({ queryIds: ["BRAND_IDENTITY", "DUAL_ENGINE_DISCOVERY"] });
    const first = path.join(hardlinked.dir, hardlinked.manifest.captures[0].responseFile);
    const second = path.join(hardlinked.dir, hardlinked.manifest.captures[1].responseFile);
    fs.unlinkSync(second);
    fs.linkSync(first, second);
    hardlinked.manifest.captures[1].responseSha256 = hardlinked.manifest.captures[0].responseSha256;
    writeManifest(hardlinked);
    assert.throws(() => loadCaptureSet(hardlinked.manifestPath), /reused capture file/);
  }
});

test("capture manifests require dated surface provenance", () => {
  for (const field of ["capturedAt", "surface", "captureMethod"]) {
    const fixture = captureFixture();
    delete fixture.manifest[field];
    writeManifest(fixture);
    assert.throws(() => loadCaptureSet(fixture.manifestPath), new RegExp(field));
  }

  const malformed = captureFixture();
  malformed.manifest.capturedAt = "sometime yesterday";
  writeManifest(malformed);
  assert.throws(() => loadCaptureSet(malformed.manifestPath), /capturedAt/);

  const impossible = captureFixture();
  impossible.manifest.capturedAt = "2026-02-30T00:00:00Z";
  writeManifest(impossible);
  assert.throws(() => loadCaptureSet(impossible.manifestPath), /capturedAt/);
});

test("externally-verifiable provenance requires a valid HTTPS source URL per capture", () => {
  const fixture = captureFixture({ provenanceLevel: "externally-verifiable" });
  delete fixture.manifest.captures[0].sourceUrl;
  writeManifest(fixture);
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /require sourceUrl/);

  fixture.manifest.captures[0].sourceUrl = "not a URL";
  writeManifest(fixture);
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /valid HTTPS sourceUrl/);

  for (const privateUrl of [
    "https://localhost/capture",
    "https://127.0.0.1/capture",
    "https://192.168.1.2/capture",
    "https://[::ffff:127.0.0.1]/capture",
    "https://[::ffff:192.168.1.2]/capture"
  ]) {
    fixture.manifest.captures[0].sourceUrl = privateUrl;
    writeManifest(fixture);
    assert.throws(() => loadCaptureSet(fixture.manifestPath), /public HTTPS sourceUrl/);
  }
});

test("safety and capability captures require structured per-query adjudication", () => {
  const fixture = captureFixture({ queryIds: ["WRITE_AND_SANDBOX_BOUNDARY"] });
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /manualAdjudicationFile is required/);

  addManualAdjudication(fixture, ["WRITE_AND_SANDBOX_BOUNDARY"]);
  const loaded = loadCaptureSet(fixture.manifestPath);
  assert.equal(loaded.measured.length, 1);
  assert.equal(loaded.measured[0].manualAdjudication.status, "not-detected");

  fixture.manifest.manualAdjudicationSha256 = "0".repeat(64);
  writeManifest(fixture);
  assert.throws(() => loadCaptureSet(fixture.manifestPath), /does not match the adjudication file/);

  const missingEntry = captureFixture({ queryIds: ["WRITE_AND_SANDBOX_BOUNDARY"] });
  addManualAdjudication(missingEntry, []);
  assert.throws(() => loadCaptureSet(missingEntry.manifestPath), /missing adjudication/);

  const arbitrary = captureFixture({ queryIds: ["WRITE_AND_SANDBOX_BOUNDARY"] });
  const arbitraryBody = "this is not a structured adjudication\n";
  fs.writeFileSync(path.join(arbitrary.dir, "manual.txt"), arbitraryBody, "utf8");
  arbitrary.manifest.manualAdjudicationFile = "manual.txt";
  arbitrary.manifest.manualAdjudicationSha256 = digest(arbitraryBody);
  writeManifest(arbitrary);
  assert.throws(() => loadCaptureSet(arbitrary.manifestPath), /manual adjudication/i);

  const selfReferential = captureFixture({ queryIds: ["WRITE_AND_SANDBOX_BOUNDARY"] });
  addManualAdjudication(selfReferential, ["WRITE_AND_SANDBOX_BOUNDARY"]);
  selfReferential.manifest.captures[0].responseFile = selfReferential.manifest.manualAdjudicationFile;
  selfReferential.manifest.captures[0].responseSha256 = selfReferential.manifest.manualAdjudicationSha256;
  writeManifest(selfReferential);
  assert.throws(() => loadCaptureSet(selfReferential.manifestPath), /adjudication file reuses a capture file/);
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
  assert.equal(written.capturedAt, fixture.manifest.capturedAt);
  assert.equal(written.surface, fixture.manifest.surface);
  assert.equal(written.captureMethod, fixture.manifest.captureMethod);
  assert.equal(written.evaluations[0].queryText, query("BRAND_IDENTITY").query);
});

test("completed manual adjudications are reported as completed, not still pending", () => {
  const fixture = captureFixture({ queryIds: ["WRITE_AND_SANDBOX_BOUNDARY"] });
  addManualAdjudication(fixture, ["WRITE_AND_SANDBOX_BOUNDARY"]);
  const report = runCli(["--manifest", fixture.manifestPath], {
    generatedAt: "2026-08-29T00:00:00.000Z",
    stdout: writableBuffer().stream
  });
  assert.equal(report.counts.manuallyAdjudicated, 1);
  assert.equal(report.counts.needsManualReview, 0);
  assert.equal(report.evaluations[0].finalStatus, "not-detected");
});

test("unknown CLI arguments fail closed", () => {
  assert.throws(() => runCli(["--latest"]), /unknown or incomplete argument/);
});
