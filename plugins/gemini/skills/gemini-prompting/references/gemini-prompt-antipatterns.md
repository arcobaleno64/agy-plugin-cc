# Gemini Prompt Anti-Patterns

Avoid these when prompting Gemini or AGY. The first six are general; the last three
are specific to this plugin's engines.

## Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

## Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

## No follow-through default

Bad:

```text
Debug this failure.
```

Better:

```xml
<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
</default_follow_through_policy>
```

## Asking for more reasoning instead of a better contract

Bad:

```text
Think harder and be very smart.
```

Better:

```xml
<verification_loop>
Before finalizing, verify that the answer matches the observed evidence and task requirements.
</verification_loop>
```

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.

## Unsupported certainty

Bad:

```text
Tell me exactly why production failed.
```

Better:

```xml
<grounding_rules>
Ground every claim in the provided context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```

## Expecting plugin `--model` / `--effort` to control AGY (AGY-specific)

Bad:

```text
Use --engine agy --model pro --effort high or combine --model with --effort when targeting AGY.
```

Better:
- For AGY, pass an exact model ID from `agy models` via `--model`, or a native effort tier (`low`, `medium`, or `high`) via `--effort`, but never both.
- Use Gemini model aliases (such as `pro` or `flash`) only with `--engine gemini`, as AGY requires exact model IDs.

Explanation: AGY encodes the effort tier into the model ID when `--model` is supplied, so passing `--model` together with `--effort` is refused before spawn. Additionally, Gemini engine aliases such as `pro` are rejected by `normalizeAgyRequestedModel` when targeting AGY. The correct usage is an exact ID from `agy models`, or a native `--effort` of `low`, `medium` or `high`, but not both.

## Expecting AGY to return output on stdout (AGY-specific)

Bad:

```text
Pipe `agy --print "..."` yourself and hope the answer arrives on stdout, or write your own version check around it.
```

Better:
- Rely on AGY's stdout JSON envelope as authoritative. The version floor guarantees it is there: an AGY too old to send it is refused by name at engine detection.
- Treat on-disk transcript recovery as salvage only, for a run killed before it printed.
- Prefer the **gemini** engine (`--output-format json`) when you need uniform, clean structured output across all environments.

Explanation: older positional `agy --print` releases did not deliver responses over a pipe (upstream google-gemini/gemini-cli#27466). Since plugin v0.11.0 the plugin reads AGY's stdout JSON envelope as authoritative, and since the version floor it does so unconditionally — an AGY that cannot send one is refused at engine detection rather than fallen back from, so no code here chooses between the two transports. On-disk transcript recovery remains only as salvage for a run killed before it printed.

## Assuming Gemini/AGY behaves like Codex (parity-specific)

Bad:

```text
Treat --effort high + AGY like Codex rescue mode and expect the same multi-turn, app-server behavior.
```

Better:
- Remember this is a CLI-per-command adapter, not a persistent app-server: each run is one turn.
- Validate Gemini/AGY output quality independently; do not assume one-to-one equivalence with Codex/GPT-5.4 routing or sandboxing.

Explanation: the Gemini plugin mirrors the *interface* of `codex-plugin-cc`, but the runtime, review mechanism (prompt-based, not native), and capability profile differ. Tighten the prompt contract rather than assuming inherited behavior.
