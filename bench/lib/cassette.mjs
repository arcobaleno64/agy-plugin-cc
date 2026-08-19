import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Recorded tool outputs for deterministic (offline, CI-safe) replay. A cassette
// captures the normalized review result for one (case, cell) so the scorer can
// run without invoking any model. `--live` re-records these.
const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASSETTE_DIR = path.join(BENCH_DIR, "cassettes");

export function cassettePath(caseId, cell) {
  return path.join(CASSETTE_DIR, caseId, `${cell}.json`);
}

export function readCassette(caseId, cell) {
  const file = cassettePath(caseId, cell);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeCassette(caseId, cell, data) {
  const file = cassettePath(caseId, cell);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    caseId,
    cell,
    recordedAt: new Date().toISOString(),
    verdict: data.verdict ?? null,
    summary: data.summary ?? null,
    findings: Array.isArray(data.findings) ? data.findings : [],
    latencyMs: data.latencyMs ?? null,
    engineVersion: data.engineVersion ?? null,
    ...(data.raw !== undefined ? { raw: data.raw } : {})
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}
