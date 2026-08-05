# Version sources: why there are six, and whether to cut one

Status: **study, no change recommended for now.** Written to answer HANDOFF §14
P1 "Version source simplification study" with something a future maintainer can
act on rather than re-derive.

## The six sources

`npm run bump-version -- <version>` writes all of them; `npm run check-version`
fails if any disagrees.

| # | Source | Read by |
|---|---|---|
| 1 | `package.json` `version` | the bump script (as the expected value), the release workflow's tag assertion, npm tooling |
| 2 | `package-lock.json` `version` | npm |
| 3 | `package-lock.json` `packages[""].version` | npm |
| 4 | `plugins/gemini/.claude-plugin/plugin.json` `version` | **Claude Code, first in its resolution order** |
| 5 | `.claude-plugin/marketplace.json` `metadata.version` | the marketplace listing |
| 6 | `.claude-plugin/marketplace.json` `plugins[gemini].version` | Claude Code, *only* when 4 is absent |

Claude Code decides an installed plugin needs updating by, in order:
`plugin.json` version → marketplace-entry version → git commit SHA.

## The risk the docs warn about

Anthropic's guidance is to avoid declaring the version in more than one place,
because `plugin.json` wins and can silently mask a stale marketplace entry. That
failure is real: bump 4 and forget 6, and the directory listing shows an old
number while clients update correctly. Users comparing the two see a
contradiction and cannot tell which is authoritative.

This repository does not carry that risk in practice, for three reasons that all
have to hold:

1. one script writes every source, so partial updates are not the normal path;
2. `npm run check-version` fails on any disagreement;
3. that check runs in PR CI and in the release workflow, and the release workflow
   additionally asserts the git tag matches `package.json`.

The duplication is therefore **mechanically enforced consistency**, not six
independent claims. That is a different situation from the one the guidance
describes.

## What removing #6 would cost

Source 6 is the only genuinely redundant one — 2 and 3 are npm's own format, and
5 describes the marketplace rather than the plugin.

Dropping it means Claude Code falls through to `plugin.json` for every install
path. That is fine for a plugin installed from this marketplace, because the
plugin source is `./plugins/gemini` in the same repository, so the manifest is
always present alongside the entry.

It is not obviously fine for the two paths that matter after directory approval:

- **The Anthropic directory pipeline.** Whether the directory reads the entry's
  `version` for its own display or pinning is not documented in a way this
  repository can rely on. Testing it means publishing a change and watching what
  the directory shows — which is not a test, it is an experiment on live users.
- **Tag-pinned installs.** A user who added the marketplace at `@v0.9.1` stays on
  that tag. Removing a field from a future `marketplace.json` cannot retroactively
  affect them, but it does mean two shapes of manifest exist in the wild, and the
  older one is what a bisect or a bug report will show.

## Recommendation

**Keep all six until there is a reason beyond tidiness.** The cost of the current
arrangement is one script and one CI check that already exist and already pass.
The cost of changing it is an unverifiable interaction with a directory pipeline
this repository does not control.

Revisit if either of these becomes true:

- Anthropic documents that the marketplace entry's `version` is ignored when
  `plugin.json` is present, in which case removing 6 is safe and mechanical;
- `check-version` or the bump script is removed or bypassed, in which case the
  enforcement that makes six sources safe is gone and the duplication becomes the
  liability the guidance describes.

If it is ever done, treat it as release engineering, not cleanup: a dedicated PR,
tested against both the independent repository marketplace and the approved
Anthropic directory entry, with the migration written down before it ships.
