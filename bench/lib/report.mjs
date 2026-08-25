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

// The first cassette's provenance used to stand for the whole cell, which is fine
// only while every case in it was recorded against the same version. It stops being
// fine the moment one case fails to re-record: `agy.model` came back four cases on
// 1.1.19 and one still on 1.1.15, and the table printed `1.1.19` for all five. That
// is the same failure the `gemini.deep` mix-up was — a column stating what it was
// supposed to be rather than what it holds — so a cell whose cassettes disagree now
// carries every version it actually has.
function provenanceByCell(rows) {
  const out = {};
  for (const cell of CELL_IDS) {
    const own = rows.filter((r) => r.cell === cell && r.provenance);
    if (own.length === 0) {
      out[cell] = null;
      continue;
    }
    const counts = new Map();
    for (const r of own) {
      const v = r.provenance.engineVersion ?? null;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    out[cell] = counts.size > 1
      ? { ...own[0].provenance, otherVersions: [...counts].slice(1).map(([version, cases]) => ({ version, cases })) }
      : own[0].provenance;
  }
  return out;
}

// The widest movement any one case showed, because a cell is only as trustworthy
// as its least stable case. `null` means at least one case never repeated.
function spreadByCell(rows) {
  const out = {};
  for (const cell of CELL_IDS) {
    const own = rows.filter((r) => r.cell === cell && r.status === "ok");
    if (own.length === 0 || own.some((r) => r.spread == null)) {
      out[cell] = null;
      continue;
    }
    out[cell] = Math.max(...own.map((r) => r.spread));
  }
  return out;
}

const AXIS_TRACKS = {
  model: "model-isolated",
  harness: "plugin-native",
  adversarial: "plugin-adversarial"
};

function cellsOn(axis) {
  const key = AXIS_TRACKS[axis];
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
  const mixed = Array.isArray(p.otherVersions) && p.otherVersions.length
    ? ` · ${p.otherVersions.map((o) => `${o.cases} case${o.cases === 1 ? "" : "s"} on ${o.version ?? "unknown"}`).join(", ")}`
    : "";
  return p.engineVersion ? `live ${day} · ${p.engineVersion}${n}${mixed}` : `live ${day}${n}${mixed}`;
}

// A seeded cassette is an illustration, not a measurement, so it cannot win an
// axis and cannot anchor a lift. Scoring it anyway is how an invented number
// reaches a reader as a result — the axis says what it has instead.
// Two ways a number can be present and still unable to win an axis, and they are
// the same objection: it is not evidence anyone can compare against.
//
//   - it was never run (seeded), or
//   - it was run once, so how far it moves between runs is unknown.
//
// The second is not pedantry on this corpus. Recording `agy.model` three times
// gave 0, 65, 65 on one case; `codex.model` gave 0, 45, 0. A single sample from
// either could have been anything, and the hardcoded 2-point noise band that used
// to guard these comparisons was calibrated against nothing at all.
function axisVerdict(cells, agg, prov, spreads) {
  const scored = cells
    .map((cell) => ({
      cell,
      tool: CELLS[cell].tool,
      score: agg[cell]?.composite,
      seeded: Boolean(prov[cell]?.seeded),
      samples: prov[cell]?.samples ?? 1,
      spread: spreads[cell]
    }))
    .filter((e) => e.score != null);
  if (scored.length === 0) return { name: "—", note: "no data" };
  const label = (e) =>
    `${e.tool} ${e.score}${e.seeded ? " (seeded)" : e.spread == null ? " (1 sample)" : ` ±${e.spread}`}`;
  const detail = scored
    .slice()
    .sort((a, b) => b.score - a.score)
    .map(label)
    .join(" · ");
  const comparable = scored.filter((e) => !e.seeded && e.spread != null);
  if (comparable.length < 2) {
    return {
      name: "—",
      note: `not decidable: ${comparable.length} of ${scored.length} cells carry repeated measurements · ${detail}`
    };
  }
  const ranked = comparable.slice().sort((a, b) => b.score - a.score);
  const lead = ranked[0].score - ranked[1].score;
  // Beat the movement, not a constant. If the gap is no wider than either cell's
  // own run-to-run range, the next recording could reverse it.
  const band = Math.max(ranked[0].spread, ranked[1].spread);
  if (lead <= band) {
    return {
      name: "tie",
      note: `lead of ${Math.round(lead * 10) / 10} does not clear the ±${band} either cell moves between runs · ${detail}`
    };
  }
  return { name: ranked[0].tool, note: detail };
}

// A lift is a comparison like any other, and was the last place still exempt from
// having to clear its own noise. `+21` between a cell that moves ±65 and one that
// moves ±16 is not a lift anyone has measured.
function harnessLifts(agg, prov, spreads) {
  const tools = [...new Set(CELL_IDS.map((c) => CELLS[c].tool))];
  return tools.map((tool) => {
    const from = CELL_IDS.find((c) => CELLS[c].tool === tool && CELLS[c].track === "model-isolated");
    const to = CELL_IDS.find((c) => CELLS[c].tool === tool && CELLS[c].track === "plugin-native");
    const lift = from && to ? liftOf(agg, from, to) : null;
    const seeded = Boolean(prov[from]?.seeded || prov[to]?.seeded);
    const ends = [spreads[from], spreads[to]];
    const band = ends.some((v) => v == null) ? null : Math.max(...ends);
    const established = lift != null && !seeded && band != null && Math.abs(lift) > band;
    return { tool, from, to, lift, seeded, band, established };
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
  const spreads = spreadByCell(rows);
  const modelAxis = axisVerdict(cellsOn("model"), agg, prov, spreads);
  const harnessAxis = axisVerdict(cellsOn("harness"), agg, prov, spreads);
  const adversarialAxis = axisVerdict(cellsOn("adversarial"), agg, prov, spreads);
  const lifts = harnessLifts(agg, prov, spreads);

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
  lines.push(`| **Adversarial** (agentic, adversarial prompt) | **${adversarialAxis.name}** | ${adversarialAxis.note} |`);
  for (const l of lifts) {
    if (l.lift == null) continue;
    const note = l.seeded
      ? "one end is seeded — not a measurement"
      : l.band == null
        ? "one end was recorded once — its noise is unknown"
        : l.established
          ? `${l.from} → ${l.to} composite, clear of the ±${l.band} its ends move`
          : `does not clear the ±${l.band} its ends move between runs`;
    lines.push(`| Harness lift — ${l.tool} | ${fmtLift(l.lift)} | ${note} |`);
  }
  lines.push("");
  lines.push("## Per-cell aggregate");
  lines.push("");
  lines.push("| Cell | Source | Cases | Composite | Spread | Recall | Precision | FP | Bonus | Sev-exact | Latency |");
  lines.push("|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|");
  for (const cell of CELL_IDS) {
    const a = agg[cell];
    lines.push(
      `| ${CELLS[cell].label} | ${describeSource(prov[cell])} | ${a.cases} | ${fmt(a.composite)} | ${spreads[cell] == null ? "—" : `±${spreads[cell]}`} | ${fmt(a.recall)} | ${fmt(a.precision)} | ${a.falsePositives} | ${a.bonus} | ${fmt(a.severityExactRate)} | ${a.latencyMs == null ? "—" : `${a.latencyMs}ms`} |`
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
  lines.push("- **Spread** is the widest gap between repeats of the same recording, on the least stable case. It is the noise band: a verdict is only named when the lead is wider than it. A cell recorded once has no spread and cannot win or lose an axis — `—` there means unknown, not stable.");
  lines.push("- A cell marked **seeded** was never run: its cassette is an illustration kept so the table has a shape, and it is excluded from every verdict and lift above.");
  lines.push("- A finding outside the planted set but on the case's `allowed_extras` list counts as **bonus** (a legitimate unique catch), not a false positive.");
  lines.push("");

  const summary = {
    mode: meta.mode ?? "replay",
    caseCount: meta.caseCount ?? null,
    modelAxisWinner: modelAxis.name,
    harnessAxisWinner: harnessAxis.name,
    harnessLifts: Object.fromEntries(
      lifts.map((l) => [l.tool, { lift: l.lift, seeded: l.seeded, band: l.band, established: l.established }])
    ),
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
