import { CELLS, CELL_IDS } from "./cells.mjs";

// Aggregate scored rows into a scorecard (markdown + a machine-readable summary).
// rows: [{ caseId, cell, status, score, latencyMs }]  (status: "ok" | "skipped" | "error")

function mean(nums) {
  const vals = nums.filter((n) => typeof n === "number" && Number.isFinite(n));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function aggregateByCell(rows) {
  const out = {};
  for (const cell of CELL_IDS) {
    const cellRows = rows.filter((r) => r.cell === cell && r.status === "ok" && r.score);
    out[cell] = {
      cell,
      cases: cellRows.length,
      composite: round1(mean(cellRows.map((r) => r.score.composite))),
      recall: round2(mean(cellRows.map((r) => r.score.recall))),
      precision: round2(mean(cellRows.map((r) => r.score.precision))),
      falsePositives: sum(cellRows.map((r) => r.score.falsePositives)),
      bonus: sum(cellRows.map((r) => r.score.bonus)),
      severityExactRate: round2(mean(cellRows.map((r) => r.score.severityExactRate))),
      latencyMs: round0(mean(cellRows.map((r) => r.latencyMs)))
    };
  }
  return out;
}

function provenanceByCell(rows) {
  const out = {};
  for (const cell of CELL_IDS) {
    out[cell] = rows.find((r) => r.cell === cell && r.provenance)?.provenance ?? null;
  }
  return out;
}

function cellsOn(axis) {
  const key = axis === "model" ? "model-isolated" : "plugin-native";
  return CELL_IDS.filter((c) => CELLS[c].track === key);
}

function describeSource(p) {
  if (!p) return "—";
  if (p.seeded) return "**seeded**";
  const day = p.recordedAt ? p.recordedAt.slice(0, 10) : "?";
  // The sample count travels with the number. A composite from one run and a
  // composite averaged over five read identically without it, and on this corpus
  // they are not comparable.
  const n = Number.isFinite(p.samples) && p.samples > 1 ? ` ×${p.samples}` : "";
  return p.engineVersion ? `live ${day} · ${p.engineVersion}${n}` : `live ${day}${n}`;
}

// A seeded cassette is an illustration, not a measurement, so it cannot win an
// axis and cannot anchor a lift. Scoring it anyway is how an invented number
// reaches a reader as a result — the axis says what it has instead.
function axisVerdict(cells, agg, prov) {
  const scored = cells
    .map((cell) => ({ cell, tool: CELLS[cell].tool, score: agg[cell]?.composite, seeded: Boolean(prov[cell]?.seeded) }))
    .filter((e) => e.score != null);
  if (scored.length === 0) return { name: "—", note: "no data" };
  const detail = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((e) => `${e.tool} ${e.score}${e.seeded ? " (seeded)" : ""}`)
    .join(" · ");
  const measured = scored.filter((e) => !e.seeded);
  if (measured.length < 2) {
    return { name: "—", note: `not decidable: ${measured.length} of ${scored.length} cells measured · ${detail}` };
  }
  const ranked = measured.slice().sort((a, b) => b.score - a.score);
  if (ranked[0].score - ranked[1].score < 2) return { name: "tie", note: `within noise · ${detail}` };
  return { name: ranked[0].tool, note: detail };
}

function harnessLifts(agg, prov) {
  const tools = [...new Set(CELL_IDS.map((c) => CELLS[c].tool))];
  return tools.map((tool) => {
    const from = CELL_IDS.find((c) => CELLS[c].tool === tool && CELLS[c].track === "model-isolated");
    const to = CELL_IDS.find((c) => CELLS[c].tool === tool && CELLS[c].track === "plugin-native");
    const lift = from && to ? liftOf(agg, from, to) : null;
    const seeded = Boolean(prov[from]?.seeded || prov[to]?.seeded);
    return { tool, from, to, lift, seeded };
  });
}

function winner(a, b, agg) {
  const sa = agg[a]?.composite;
  const sb = agg[b]?.composite;
  if (sa == null && sb == null) return { name: "—", note: "no data" };
  if (sa == null) return { name: CELLS[b].tool, note: `${a} had no data` };
  if (sb == null) return { name: CELLS[a].tool, note: `${b} had no data` };
  if (Math.abs(sa - sb) < 2) return { name: "tie", note: `within noise (${sa} vs ${sb})` };
  return sa > sb
    ? { name: CELLS[a].tool, note: `${sa} vs ${sb}` }
    : { name: CELLS[b].tool, note: `${sb} vs ${sa}` };
}

export function buildScorecard(rows, meta = {}) {
  const agg = aggregateByCell(rows);
  const prov = provenanceByCell(rows);
  const modelAxis = axisVerdict(cellsOn("model"), agg, prov);
  const harnessAxis = axisVerdict(cellsOn("harness"), agg, prov);
  const lifts = harnessLifts(agg, prov);

  const lines = [];
  lines.push("# review benchmark scorecard — agy · gemini · codex");
  lines.push("");
  lines.push(`> Mode: **${meta.mode ?? "replay"}**${meta.repeats ? ` · repeats: ${meta.repeats}` : ""} · cases: ${meta.caseCount ?? "?"} · generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Verdicts");
  lines.push("");
  lines.push("| Axis | Winner | Detail |");
  lines.push("|---|---|---|");
  lines.push(`| **Model** (single-shot, tools off) | **${modelAxis.name}** | ${modelAxis.note} |`);
  lines.push(`| **Harness** (agentic reviewers) | **${harnessAxis.name}** | ${harnessAxis.note} |`);
  for (const l of lifts) {
    if (l.lift == null) continue;
    const note = l.seeded ? "one end is seeded — not a measurement" : `${l.from} → ${l.to} composite`;
    lines.push(`| Harness lift — ${l.tool} | ${fmtLift(l.lift)} | ${note} |`);
  }
  lines.push("");
  lines.push("## Per-cell aggregate");
  lines.push("");
  lines.push("| Cell | Source | Cases | Composite | Recall | Precision | FP | Bonus | Sev-exact | Latency |");
  lines.push("|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|");
  for (const cell of CELL_IDS) {
    const a = agg[cell];
    lines.push(
      `| ${CELLS[cell].label} | ${describeSource(prov[cell])} | ${a.cases} | ${fmt(a.composite)} | ${fmt(a.recall)} | ${fmt(a.precision)} | ${a.falsePositives} | ${a.bonus} | ${fmt(a.severityExactRate)} | ${a.latencyMs == null ? "—" : `${a.latencyMs}ms`} |`
    );
  }
  lines.push("");
  lines.push("## Per-case breakdown");
  lines.push("");
  lines.push("| Case | Cell | Status | Composite | Recall | FP | Bonus | Missed |");
  lines.push("|---|---|:-:|:-:|:-:|:-:|:-:|---|");
  for (const r of rows) {
    if (r.status !== "ok") {
      lines.push(`| ${r.caseId} | ${r.cell} | ${r.status}${r.note ? ` (${r.note})` : ""} | — | — | — | — | — |`);
      continue;
    }
    const s = r.score;
    lines.push(`| ${r.caseId} | ${r.cell} | ok | ${s.composite} | ${fmt(s.recall)} | ${s.falsePositives} | ${s.bonus} | ${s.missed.join(", ") || "—"} |`);
  }
  lines.push("");
  lines.push("## Caveats");
  lines.push("");
  lines.push("- The **model axis** isolates raw single-shot quality (diff embedded, tools forbidden); the **harness axis** is each tool's repo-exploring reviewer. Most real-world gap lives on the harness axis — see `docs/MODEL_COMPARISON.md`.");
  lines.push("- Composite = `recall*70 + precision*20 + severityExact*10` (0–100); it is a summary, not a verdict — read the columns.");
  lines.push("- In `--live` mode model output is non-deterministic; treat single-digit composite gaps as noise. Use `--repeats N` to average.");
  lines.push("- A cell marked **seeded** was never run: its cassette is an illustration kept so the table has a shape, and it is excluded from every verdict and lift above.");
  lines.push("- A finding outside the planted set but on the case's `allowed_extras` list counts as **bonus** (a legitimate unique catch), not a false positive.");
  lines.push("");

  const summary = {
    mode: meta.mode ?? "replay",
    caseCount: meta.caseCount ?? null,
    modelAxisWinner: modelAxis.name,
    harnessAxisWinner: harnessAxis.name,
    harnessLifts: Object.fromEntries(lifts.map((l) => [l.tool, { lift: l.lift, seeded: l.seeded }])),
    provenance: prov,
    byCell: agg
  };
  return { markdown: lines.join("\n"), summary };
}

function liftOf(agg, fromCell, toCell) {
  const a = agg[fromCell]?.composite;
  const b = agg[toCell]?.composite;
  if (a == null || b == null) return null;
  return round1(b - a);
}
function fmtLift(v) {
  if (v == null) return "—";
  return v >= 0 ? `+${v}` : `${v}`;
}
function fmt(v) {
  return v == null ? "—" : String(v);
}
function sum(nums) {
  return nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}
function round0(n) {
  return n == null ? null : Math.round(n);
}
function round1(n) {
  return n == null ? null : Math.round(n * 10) / 10;
}
function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}
