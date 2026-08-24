// The benchmark cells. Three axes fall out of these:
//   model axis       = the "model-isolated" cells (same neutral prompt+diff, no tools)
//   harness axis     = the "plugin-native" cells (each tool's own default reviewer)
//   adversarial axis = the "plugin-adversarial" cells (each tool's adversarial reviewer)
// and the within-tool "single-shot -> agentic" delta is the harness lift.
//
// The adversarial axis is separate rather than folded into the harness axis, because
// the prompts are not interchangeable: this plugin's `review.md` asks for a pragmatic
// review and `adversarial-review.md` asks the model to break confidence in the change.
// On a corpus scored mostly on recall, the second wins by construction. Putting an
// adversarial reading in the same column as a pragmatic one would be a column stating
// what it is supposed to hold rather than what it holds.
export const CELLS = {
  "gemini.model": { tool: "gemini", track: "model-isolated", harness: "single-shot", label: "Gemini (model, single-shot)" },
  "codex.model": { tool: "codex", track: "model-isolated", harness: "single-shot", label: "Codex (model, single-shot)" },
  "agy.model": { tool: "agy", track: "model-isolated", harness: "single-shot", label: "AGY (model, single-shot)" },
  "gemini.deep": { tool: "gemini", track: "plugin-native", harness: "agentic", label: "Gemini (--deep, agentic)" },
  "codex.native": { tool: "codex", track: "plugin-native", harness: "agentic", label: "Codex (native review, agentic)" },
  "agy.deep": { tool: "agy", track: "plugin-native", harness: "agentic", label: "AGY (--deep, agentic)" },
  "gemini.adversarial": { tool: "gemini", track: "plugin-adversarial", harness: "agentic", label: "Gemini (adversarial, agentic)" },
  "codex.adversarial": { tool: "codex", track: "plugin-adversarial", harness: "agentic", label: "Codex (adversarial, agentic)" },
  "agy.adversarial": { tool: "agy", track: "plugin-adversarial", harness: "agentic", label: "AGY (adversarial, agentic)" }
};

export const CELL_IDS = Object.keys(CELLS);
