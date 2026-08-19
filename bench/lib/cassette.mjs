import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Recorded tool outputs for deterministic (offline, CI-safe) replay. A cassette
// captures the normalized review result for one (case, cell) so the scorer can
// run without invoking any model. `--live` re-records these.
//
// It captures every repeat, not just the last. `--repeats N` used to average the
// live scorecard and then store one run, so the number that got published — which
// comes from replay — was a single sample wearing an averaged run's reputation.
// On this corpus one cell moved 65 to 0 between two recordings minutes apart, so
// which single sample survived was not a detail.
//
// The top-level verdict/summary/findings stay as the last run's, for anything
// reading a cassette as one review; `samples` is what the scorer reads.
const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASSETTE_DIR = path.join(BENCH_DIR, "cassettes");

export function cassettePath(caseId, cell) {
  return path.join(CASSETTE_DIR, caseId, `${cell}.json`);
}

export function readCassette(caseId, cell) {
  const file = cassettePath(caseId, cell);
  if (!fs.existsSync(file)) return null;
  const cassette = JSON.parse(fs.readFileSync(file, "utf8"));
  // Cassettes recorded before `samples` existed, and every seeded one, are one
  // run. Normalising here means the scorer never has to ask which era it is in.
  if (!Array.isArray(cassette.samples) || cassette.samples.length === 0) {
    cassette.samples = [
      {
        verdict: cassette.verdict ?? null,
        summary: cassette.summary ?? null,
        findings: Array.isArray(cassette.findings) ? cassette.findings : [],
        latencyMs: cassette.latencyMs ?? null
      }
    ];
  }
  return cassette;
}

export function writeCassette(caseId, cell, data, samples = null) {
  const file = cassettePath(caseId, cell);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const runs = (Array.isArray(samples) && samples.length > 0 ? samples : [data]).map((run) => ({
    verdict: run.verdict ?? null,
    summary: run.summary ?? null,
    findings: Array.isArray(run.findings) ? run.findings : [],
    latencyMs: run.latencyMs ?? null
  }));
  const payload = {
    caseId,
    cell,
    recordedAt: new Date().toISOString(),
    verdict: data.verdict ?? null,
    summary: data.summary ?? null,
    findings: Array.isArray(data.findings) ? data.findings : [],
    latencyMs: data.latencyMs ?? null,
    engineVersion: data.engineVersion ?? null,
    samples: runs,
    ...(data.raw !== undefined ? { raw: data.raw } : {})
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}
