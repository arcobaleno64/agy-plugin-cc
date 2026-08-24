// The benchmark cells. Three axes fall out of these:
//   model axis       = the "model-isolated" cells (same neutral prompt+diff, no tools)
//   harness axis     = the "plugin-native" cells (each tool's own default reviewer)
//   adversarial axis = the "plugin-adversarial" cells (each tool's adversarial reviewer)
// and the within-tool "single-shot -> agentic" delta is the harness lift.
//
// The "plugin-shallow" cells are a control, not an axis. They run the plugin's own
// review without --deep: the same `prompts/review.md`, the same diff embedded in
// REVIEW_INPUT, no tools and no workspace. That splits the harness lift, which
// otherwise spans a prompt change and an exploration change at once, into the two
// halves it is made of — `*.model -> *.shallow` is the prompt, `*.shallow -> *.deep`
// is the exploration. They are deliberately outside every axis ranking: their only
// job is to be a fixed end for those two deltas.
//
// `needsRepo` is declared rather than inferred. It used to be read off
// `harness === "agentic"`, which is true of every cell that runs a companion — until
// these two, which run one without exploring. Inferring it left them with no
// materialized repository and a `--cwd` pointing at nothing.
//
// The adversarial axis is separate rather than folded into the harness axis, because
// the prompts are not interchangeable: this plugin's `review.md` asks for a pragmatic
// review and `adversarial-review.md` asks the model to break confidence in the change.
// Putting an adversarial reading in the same column as a pragmatic one would be a
// column stating what it is supposed to hold rather than what it holds.
//
// The separation was argued before it was measured, and the prediction was wrong in
// direction. The guess was that a prompt asking the model to break confidence would
// trade precision for recall on a composite weighted `recall*70`. Measured on agy,
// 1.1.19, five cases x3: recall 0.81 -> 0.77, precision 0.91 -> 0.92, false positives
// 1.67 -> 1.33. The adversarial prompt made the reviewer more conservative, not more
// aggressive. The axis stays separate because the prompts still are not
// interchangeable, which is a fact about the prompts rather than about the scores.
export const CELLS = {
  "gemini.model": { tool: "gemini", track: "model-isolated", harness: "single-shot", label: "Gemini (model, single-shot)" },
  "codex.model": { tool: "codex", track: "model-isolated", harness: "single-shot", label: "Codex (model, single-shot)" },
  "agy.model": { tool: "agy", track: "model-isolated", harness: "single-shot", label: "AGY (model, single-shot)" },
  "gemini.deep": { tool: "gemini", track: "plugin-native", harness: "agentic", label: "Gemini (--deep, agentic)" },
  "codex.native": { tool: "codex", track: "plugin-native", harness: "agentic", label: "Codex (native review, agentic)" },
  "agy.deep": { tool: "agy", track: "plugin-native", harness: "agentic", label: "AGY (--deep, agentic)" },
  "gemini.shallow": { tool: "gemini", track: "plugin-shallow", harness: "single-shot", needsRepo: true, label: "Gemini (plugin review, no --deep)" },
  "agy.shallow": { tool: "agy", track: "plugin-shallow", harness: "single-shot", needsRepo: true, label: "AGY (plugin review, no --deep)" },
  "gemini.adversarial": { tool: "gemini", track: "plugin-adversarial", harness: "agentic", label: "Gemini (adversarial, agentic)" },
  "codex.adversarial": { tool: "codex", track: "plugin-adversarial", harness: "agentic", label: "Codex (adversarial, agentic)" },
  "agy.adversarial": { tool: "agy", track: "plugin-adversarial", harness: "agentic", label: "AGY (adversarial, agentic)" }
};

export const CELL_IDS = Object.keys(CELLS);
