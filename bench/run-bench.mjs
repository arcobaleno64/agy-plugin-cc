#!/usr/bin/env node
// codex vs gemini review benchmark orchestrator.
//
//   node bench/run-bench.mjs                 # deterministic replay from cassettes
//   node bench/run-bench.mjs --live          # run the real CLIs, refresh cassettes
//   node bench/run-bench.mjs --case auth-basic --cell gemini.model --repeats 3
//
// Deterministic mode needs no auth/network; --live needs gemini (and, for the
// codex.native cell, BENCH_CODEX_COMPANION pointing at codex-companion.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CELLS, CELL_IDS } from "./lib/cells.mjs";
import { listCases, loadCase, materializeCase } from "./lib/corpus.mjs";
import { readCassette, writeCassette } from "./lib/cassette.mjs";
import { runCell } from "./lib/adapters.mjs";
import { scoreReview } from "./lib/score.mjs";
import { buildScorecard } from "./lib/report.mjs";

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(BENCH_DIR, "results");

function parseArgs(argv) {
  const opts = { live: false, repeats: 1, cases: null, cells: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--live") opts.live = true;
    else if (a === "--repeats") opts.repeats = Math.max(1, Number(argv[++i]) || 1);
    else if (a === "--case") opts.cases = (opts.cases ?? []).concat(argv[++i]);
    else if (a === "--cell") opts.cells = (opts.cells ?? []).concat(argv[++i]);
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
  }
  return opts;
}

function avgScores(scores) {
  const keys = ["recall", "precision", "severityExactRate", "composite", "falsePositives", "bonus"];
  const out = { ...scores[scores.length - 1] };
  for (const k of keys) {
    const vals = scores.map((s) => s[k]).filter((n) => Number.isFinite(n));
    out[k] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : out[k];
  }
  out.composite = Math.round(out.composite);
  return out;
}

function liveCell({ caseId, cell, promptText, repeats, truth }) {
  let repoCtx = null;
  const needsRepo = CELLS[cell]?.harness === "agentic";
  try {
    const scores = [];
    const results = [];
    let last = null;
    for (let r = 0; r < repeats; r += 1) {
      if (CELLS[cell]?.track === "model-isolated" && !promptText) {
        return { status: "skipped", note: "no diff materialized for this case" };
      }
      const ctx = { promptText };
      if (needsRepo) {
        repoCtx = materializeCase(caseId);
        ctx.repoDir = repoCtx.repoDir;
      }
      const result = runCell(cell, ctx);
      if (needsRepo && repoCtx) { repoCtx.cleanup(); repoCtx = null; }
      if (!result.ok) return { status: "skipped", note: result.error, latencyMs: result.latencyMs };
      last = result;
      results.push(result);
      scores.push(scoreReview(result.findings, truth));
    }
    writeCassette(caseId, cell, last, results);
    return {
      status: "ok",
      score: avgScores(scores),
      latencyMs: last.latencyMs,
      provenance: {
        seeded: false,
        recordedAt: new Date().toISOString(),
        engineVersion: last.engineVersion ?? null,
        samples: results.length
      }
    };
  } finally {
    if (repoCtx) repoCtx.cleanup();
  }
}

function replayCell({ caseId, cell, truth }) {
  const cassette = readCassette(caseId, cell);
  if (!cassette) return { status: "skipped", note: "no cassette" };
  const scores = cassette.samples.map((run) => scoreReview(run.findings, truth));
  const latencies = cassette.samples.map((run) => run.latencyMs).filter((n) => Number.isFinite(n));
  return {
    status: "ok",
    score: avgScores(scores),
    latencyMs: latencies.length
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : cassette.latencyMs,
    provenance: {
      seeded: Boolean(cassette.source),
      recordedAt: cassette.recordedAt ?? null,
      engineVersion: cassette.engineVersion ?? null,
      samples: cassette.samples.length
    }
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node bench/run-bench.mjs [--live] [--repeats N] [--case ID]... [--cell ID]... [--out FILE]");
    return;
  }

  const allCases = listCases();
  const cases = opts.cases ? allCases.filter((c) => opts.cases.includes(c)) : allCases;
  const cells = opts.cells ? CELL_IDS.filter((c) => opts.cells.includes(c)) : CELL_IDS;
  if (cases.length === 0) {
    console.error("No cases found in bench/corpus/.");
    process.exitCode = 1;
    return;
  }

  const rows = [];
  for (const caseId of cases) {
    const { truth, promptTemplate } = loadCase(caseId);
    let diffText = null;
    if (opts.live && cells.some((c) => CELLS[c]?.track === "model-isolated")) {
      const mat = materializeCase(caseId);
      diffText = mat.diffText;
      mat.cleanup();
    }
    for (const cell of cells) {
      const promptText = diffText != null ? promptTemplate.replace("{{DIFF}}", diffText) : null;
      const res = opts.live
        ? liveCell({ caseId, cell, promptText, repeats: opts.repeats, truth })
        : replayCell({ caseId, cell, truth });
      rows.push({ caseId, cell, ...res });
      process.stderr.write(`· ${caseId} / ${cell}: ${res.status}${res.note ? ` (${res.note})` : ""}\n`);
    }
  }

  const { markdown, summary } = buildScorecard(rows, {
    mode: opts.live ? "live" : "replay",
    repeats: opts.repeats,
    caseCount: cases.length
  });

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const mdOut = opts.out || path.join(RESULTS_DIR, "scorecard.md");
  fs.writeFileSync(mdOut, `${markdown}\n`);
  fs.writeFileSync(path.join(RESULTS_DIR, "scorecard.json"), `${JSON.stringify(summary, null, 2)}\n`);

  process.stdout.write(`${markdown}\n`);
  process.stderr.write(`\nScorecard written to ${mdOut}\n`);
}

// Run only when invoked as the CLI. Importing this file used to run the whole
// benchmark, which is why `replayCell` had no test — and replay is where the
// published number comes from.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

export const _internal = { replayCell, avgScores };
