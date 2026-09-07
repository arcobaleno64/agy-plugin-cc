// Single source of truth for Gemini model aliases and reasoning-effort mapping.
//
// The README "Model Aliases" table is verified against this data by
// tests/model-map.test.mjs, so update aliases here and the table stays in sync.
//
// Preview model IDs (those ending in `-preview`) track Google's Gemini preview
// channel and can change without notice; override any alias with `--model <id>`.
//
//   lastVerified: every id below re-confirmed 2026-08-05 against the live
//                 generativelanguage.googleapis.com v1beta models.list, which
//                 returned 58 models. All six ids used here were present.
//   source:       Google Gemini API models.list (authoritative for id validity;
//                 the gemini CLI forwards these ids to the same API).
//
// Note on method: consumer Gemini CLI access ended 2026-06-18, so an OAuth
// personal account can no longer probe models — it answers API_KEY_INVALID. A
// Standard/Enterprise account or an API key is required to repeat this check.
export const MODEL_MAP_METADATA = {
  lastVerified: "2026-08",
  source: "Google Gemini API v1beta models.list, probed 2026-08-05",
  note: "Preview model IDs (…-preview) track Google's preview channel and may change; override with --model <id>. As of the 2026-08-05 probe all ids below resolve. gemini-3.5-pro is still absent from the listing, but gemini-3.5-flash and gemini-3.6-flash are now GA — see the alias note below. Unknown/unavailable model ids degrade gracefully to the GA fallback at runtime."
};

// Open question, deliberately not changed here: `flash` and `pro` resolve to
// preview ids while GA equivalents now exist (gemini-3.6-flash, gemini-3.5-flash
// per the 2026-08-05 listing). Repointing them would cut the drift risk this
// file warns about, but it changes which model every unqualified run uses, so it
// belongs in its own release with its own decision.

// Ordered alias entries. `preview: true` marks IDs that can change.
export const MODEL_ALIAS_ENTRIES = [
  { alias: "flash", model: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", preview: true },
  { alias: "flash3", model: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)", preview: true },
  { alias: "pro", model: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", preview: true },
  { alias: "pro3", model: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)", preview: true },
  { alias: "lite3", model: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite (GA, cost-efficient)", preview: false },
  { alias: "flash25", model: "gemini-2.5-flash", label: "Stable 2.5 Flash (GA)", preview: false },
  { alias: "pro25", model: "gemini-2.5-pro", label: "Stable 2.5 Pro (GA)", preview: false },
  { alias: "lite", model: "gemini-2.5-flash-lite", label: "Cost-efficient (GA)", preview: false },
  { alias: "fast", model: "gemini-2.5-flash-lite", label: "Cost-efficient (GA)", preview: false }
];

export const MODEL_ALIASES = new Map(MODEL_ALIAS_ENTRIES.map((entry) => [entry.alias, entry.model]));

// Reasoning-effort tier -> resolved model, used when --effort is supplied
// without an explicit --model. These apply to the GEMINI engine only.
//
// AGY has its own model surface and takes exact ids from `agy models`; the two
// namespaces do not overlap, which is why normalizeAgyRequestedModel rejects
// Gemini aliases outright. The structural reason is what matters and does not
// change: AGY encodes the effort tier into the id (`gemini-3.7-flash-high`),
// while this map keeps model and effort separate, so no AGY id is ever a valid
// value here. AGY also accepts native --effort low|medium|high, which the
// declared version floor (AGY_MINIMUM_VERSION in engine.mjs) guarantees.
//
// This comment used to enumerate the AGY ids as of 1.1.10, and by 1.1.13 the
// listing had gained three that it did not mention. Nothing depended on the
// list — normalizeAgyRequestedModel checks the character set and rejects Gemini
// aliases, and never compares against a roster — so it was a copy that could
// only drift. It is not re-enumerated here: `agy models` is the live answer, and
// there is no machine-readable form of it to check a copy against (`agy models`
// on 1.1.13 accepts only -h/--help; the plugin's own 0.19.0 changelog entry says
// 1.1.12 added `--output-format json` to it, and that is not true of 1.1.13).
// The dated readings live in docs/MODEL_COMPARISON.md §D, which exists to hold
// exactly that kind of record.
export const EFFORT_MODEL_MAP = new Map([
  ["none", "gemini-2.5-flash-lite"],
  ["minimal", "gemini-2.5-flash-lite"],
  ["low", "gemini-3-flash-preview"],
  ["medium", "gemini-3-flash-preview"],
  ["high", "gemini-3.1-pro-preview"],
  ["xhigh", "gemini-3.1-pro-preview"]
]);

export const VALID_EFFORT_LEVELS = new Set(EFFORT_MODEL_MAP.keys());
