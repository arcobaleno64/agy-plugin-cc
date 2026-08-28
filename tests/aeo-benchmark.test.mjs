import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateResponseSynthesis, runAeoBenchmark, loadCapturedResponses } from "../scripts/aeo-benchmark.mjs";

// The scorer's job is to answer "did this response mention the thing", so
// sentence punctuation around the mention must not change the answer. The
// boundary it uses to avoid matching inside a longer identifier is where that
// can go wrong, which is what these pin.
const base = { id: "T", expectedBrand: "", keywordClusters: [], expectedSourceDomains: [] };
const scoreFor = (text, cluster) =>
  evaluateResponseSynthesis(text, { ...base, keywordClusters: [cluster] }).matchedKeywords;

test("a keyword is found at the end of a sentence, not only mid-sentence", () => {
  for (const text of [
    "the plugin supports sarif. next sentence",
    "the plugin supports sarif, and more",
    "the plugin supports sarif and more",
    "the plugin supports sarif"
  ]) {
    assert.deepEqual(scoreFor(text, ["sarif"]), ["sarif"], `not found in: ${text}`);
  }
});

test("a dotted identifier is found when a sentence ends on it", () => {
  assert.deepEqual(
    scoreFor("register gemini-mcp.mjs. then restart", ["gemini-mcp.mjs"]),
    ["gemini-mcp.mjs"]
  );
});

test("a keyword is still not matched inside a longer identifier", () => {
  // These are the false positives the boundary exists to prevent; a fix that
  // loosens it until the tests above pass must not let these through.
  assert.deepEqual(scoreFor("register gemini-mcp.mjs now", ["gemini-mcp"]), []);
  assert.deepEqual(scoreFor("the sarifx format", ["sarif"]), []);
  assert.deepEqual(scoreFor("the xsarif format", ["sarif"]), []);
  assert.deepEqual(scoreFor("see my.env.example here", [".env"]), []);
});

test("an empty evaluation set scores zero rather than dividing by it", () => {
  const report = runAeoBenchmark([]);
  assert.equal(report.totalQueries, 0);
  assert.equal(report.overallPassRate, 0);
});

// --- captured-response loading ------------------------------------------------

const queries = [{ id: "Q_ONE" }, { id: "Q_TWO" }];

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aeo-fixtures-"));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body, "utf8");
  }
  return dir;
}

test("a query with no captured response is unmeasured, not failed", () => {
  const dir = fixtureDir({ "Q_ONE.md": "<!-- captured: 2026-08-24 | assistant: X -->\nbody" });
  const { measured, unmeasured } = loadCapturedResponses(queries, dir);

  assert.equal(measured.length, 1);
  assert.deepEqual(unmeasured.map(u => u.queryId), ["Q_TWO"]);

  // The distinction has to survive into the rates, which is the whole point:
  // scoring the missing one as a zero would read as "the assistant answered badly".
  const report = runAeoBenchmark(measured.map(() => ({ isDomainCited: true, isDirectlyRecommended: true, passed: true, keywordMatchRate: 100 })));
  assert.equal(report.totalQueries, 1, "rates are over measured queries only");
  assert.equal(report.overallPassRate, 100);
});

test("a fixture with no provenance line is refused rather than scored", () => {
  const dir = fixtureDir({ "Q_ONE.md": "agy-plugin-cc is the answer" });
  assert.throws(() => loadCapturedResponses(queries, dir), /provenance/i);
});

test("the provenance line is not scored as part of the response", () => {
  const dir = fixtureDir({
    "Q_ONE.md": "<!-- captured: 2026-08-24 | assistant: ChatGPT 5 -->\n\nthe body\n"
  });
  const [first] = loadCapturedResponses(queries, dir).measured;

  assert.equal(first.body, "the body");
  assert.equal(first.capturedAt, "2026-08-24");
  assert.equal(first.assistant, "ChatGPT 5");
});
