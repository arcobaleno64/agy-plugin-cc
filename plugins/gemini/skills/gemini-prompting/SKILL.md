---
name: gemini-prompting
description: Internal guidance for composing Gemini and AGY prompts for coding, review, diagnosis, and research tasks inside the Gemini Claude Code plugin
user-invocable: false
---

# Gemini Prompting

Use this skill when `gemini:gemini-rescue` needs to prepare a prompt for Gemini or AGY.

Prompt the model like an operator, not a collaborator. Keep prompts compact and block-structured with XML tags. State the task, the output contract, the follow-through defaults, and the small set of extra constraints that matter.

Core rules:
- Prefer one clear task per run. Split unrelated asks into separate runs.
- Tell the model what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over raising reasoning or adding long natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Default prompt recipe:
- `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what the model should do by default instead of asking routine questions.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

Model selection guidance (`<model_selection>` block):
- Debug or fix tasks → `--effort high` (→ gemini-3.1-pro-preview)
- Research or review tasks → `--effort medium` (→ gemini-3-flash-preview)
- Quick formatting or structure tasks → `--effort low` (→ gemini-3-flash-preview)
- AGY engine: `--model` takes an exact model id as listed by `agy models`; `--effort` takes a native `low`, `medium`, or `high`; the two are mutually exclusive; and Gemini aliases are rejected for AGY.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or adversarial review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so the model stays narrow and avoids unrelated refactors.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names.
- Do not raise reasoning or complexity first. Tighten the prompt and verification rules before adding more model power.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Prompt assembly checklist:
1. Define the exact task and scope in `<task>`.
2. Choose the smallest output contract that still makes the answer easy to use.
3. Decide whether the model should keep going by default or stop for missing high-risk details.
4. Add verification, grounding, and safety tags only where the task needs them.
5. Remove redundant instructions before sending the prompt.

## References

- [references/gemini-prompt-blocks.md](references/gemini-prompt-blocks.md) — the reusable XML block catalogue (including `json_output_contract` and `model_selection`).
- [references/gemini-prompt-recipes.md](references/gemini-prompt-recipes.md) — end-to-end templates for diagnosis, narrow fix, review, research, and prompt-patching.
- [references/gemini-prompt-antipatterns.md](references/gemini-prompt-antipatterns.md) — anti-patterns covering vague framing, missing contracts, follow-through defaults, reasoning misuse, job mixing, unsupported certainty, and AGY/Codex engine pitfalls.
