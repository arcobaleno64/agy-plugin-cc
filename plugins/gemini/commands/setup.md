---
description: Check whether Gemini CLI / AGY is ready and optionally toggle the stop-time review gate
argument-hint: '[--engine <agy|gemini>] [--probe-agy] [--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), Bash(curl:*), AskUserQuestion
---

Run this exactly as written — `--json` belongs inside the quoted argument string.
A token placed beside that quoted string makes it a second argv element, and every
flag inside it is then read as one positional and ignored, which is how
`/gemini:setup --engine gemini` came back reporting a different engine:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "--json $ARGUMENTS"
```

Gemini CLI and AGY are first-class supported engines. Each is a conditional
dependency: the user only needs the binary for the engine they select. In
`auto` mode Gemini is checked first because it exposes the plugin's JSON/model
contract, then AGY is checked; that order does not make AGY an optional or
lower-tier integration. Drive the install decisions below off the setup JSON's
`requestedEngine` field, which already resolves both the `--engine` flag and
the `GEMINI_ENGINE` environment variable — do **not** branch on the raw
`$ARGUMENTS` text.

If the result says Gemini CLI is unavailable (`gemini.available` is false), npm
is available, and `requestedEngine` is **not** `agy`:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Gemini CLI now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Gemini CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @google/gemini-cli
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "--json $ARGUMENTS"
```

When `requestedEngine` is `agy` and AGY is unavailable
(`agy.available` is false):
- Use `AskUserQuestion` exactly once to ask whether Claude should install AGY now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install AGY (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "--json $ARGUMENTS"
```

Do not ask about installation when:
- the selected engine is already available (even if it still needs
  authentication), or
- Gemini CLI is the missing selected/auto candidate and npm is unavailable, or
- the only missing engine is AGY and `requestedEngine` is not `agy`. In that
  case AGY is not the selected conditional dependency, so do not push its
  installation.

When `requestedEngine` is `agy` and AGY is unavailable, the AGY install prompt
above takes precedence even if Gemini CLI is already present — the user routed
to AGY (via `--engine agy` or `GEMINI_ENGINE=agy`), so do not silently fall back
to Gemini.

AGY authentication cannot be read off disk, so an unprobed `--engine agy` reports
`readyState: "partial"` with `agyAuth.state: "unknown"` — that is "not checked",
not "not signed in". When the user asks whether AGY is ready, or when they are
about to act on a `partial` verdict, rerun with `--probe-agy`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "--json --probe-agy $ARGUMENTS"
```

It asks AGY a read-only question the account has to answer, so it verifies the
login without starting a turn or spending quota (AGY 1.1.11+; below that it
declines and says so). A verified AGY then reports `readyState: "ready"`; a probe
that comes back `logged-out` reports `not-ready`, and the fix is to run `agy`
once interactively.

There is a matching `--probe-gemini`, and **it is not free**. Gemini CLI has no
question the account answers without generating, so the probe makes a real
request: on a credential that no longer works it costs nothing (the API refuses it
before generating), but on a working credential it spends a turn. Do not offer it
by reflex the way `--probe-agy` can be offered — suggest it only when the report
says a stored gemini credential cannot be trusted, or when the user asks whether
gemini really works:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup "--json --probe-gemini $ARGUMENTS"
```

Without it, gemini readiness is read off disk, which can only prove staleness, not
health: a present-but-expired `oauth_creds.json` now blocks the `ready` claim and
reports `partial`, while a credential living only in the OS keychain cannot be
judged at all (0.53.1 migrates the file into the keychain and deletes it). A probe
that comes back `logged-out` reports `not-ready` for an explicitly requested
`--engine gemini`, and stays `partial` under `auto` when AGY is installed, because
auto routes to AGY when gemini's credential does not work.

Output rules:
- Present the final setup output to the user.
- `geminiReady` and `geminiAuth.loggedIn` answer different questions and can
  disagree: `geminiAuth` inspects the OAuth file alone, while readiness uses the
  full credential resolution (env API key, that file, then the OS keychain).
  `geminiCredentialSource` names the one that actually applied — quote it rather
  than reporting the pair as a contradiction.
- If installation was skipped, present the original setup output.
- If Gemini is installed but not authenticated, preserve the guidance to run `!gemini` once to complete OAuth authentication. The plugin authenticates by running `gemini`; there is no separate login subcommand.
- If the setup output (`nextSteps` / `geminiPlanTier`) includes a 2026-06-18 EOL heads-up, surface it: personal-plan Gemini CLI free access ends then. After that date, either upgrade to Gemini Code Assist Standard/Enterprise to keep the gemini engine, or use `--engine agy` (the plugin recovers AGY responses from its on-disk transcript because `agy --print` does not pipe output — upstream google-gemini/gemini-cli#27466).
