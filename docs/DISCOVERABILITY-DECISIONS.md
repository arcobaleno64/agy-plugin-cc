# Discoverability decision record

This reference records discoverability tactics that the project deliberately rejects or defers, and why. It is not a ranking playbook, a crawler policy, or evidence that any search or assistant surface will use the repository.

The controlling scope is [Issue #121](https://github.com/arcobaleno64/agy-plugin-cc/issues/121). Product behavior and trust boundaries remain authoritative in the [README](../README.md), [FAQ](FAQ.md), [privacy policy](../PRIVACY.md), [security policy](../SECURITY.md), and [threat model](THREAT-MODEL.md).

## Decision rule

A tactic is accepted only when it improves a truthful public surface or produces reproducible evidence without changing runtime behavior merely for discoverability. A green metric is not enough: the result must still identify the canonical repository, preserve claim-to-evidence links, and avoid implying causation from a small or self-authored sample.

Each decision below can be revisited only when its stated trigger becomes true. Until then, repeating the tactic is not new evidence.

## Rejected tactics

| Tactic | Decision | Why | Revisit only when |
|---|---|---|---|
| Keyword stuffing, doorway pages, artificial backlinks, mass directory submissions, or engagement manipulation | Reject | These can inflate proxy metrics without improving product truth, create maintenance and platform-policy risk, and make canonical identity less clear. | Never as a project-maintained tactic. |
| Unsupported superlatives, rankings, adoption claims, or “official” positioning | Reject | The repository has no evidence for “best,” “leading,” broad adoption, or endorsement by Google, Anthropic, or OpenAI. | Independent, attributable evidence exists and the wording remains narrowly factual. |
| Universal read-only, filesystem confinement, or sandbox guarantees | Reject | Review mode expresses intent and performs checks; it is not a permission boundary. Delegated engines may write, and the plugin does not supply a filesystem sandbox. | Only after a separately reviewed security-boundary change with adversarial tests and updated security documentation. |
| Treating self-authored fixtures as independent visibility evidence | Reject | Fixtures can test evaluator behavior but cannot establish what an external search or assistant returned. Optimizing the fixture would optimize the measurement rather than discoverability. | Never; use dated captures with explicit provenance instead. |
| Converting one surface-specific observation into a visibility rate, trend, or causal SEO/AEO/GEO claim | Reject | Search surfaces can disagree sharply, and a six-query capture cannot support population-level or causal conclusions. | A predeclared, repeated, multi-surface design with sufficient independent observations supports the claimed inference. |
| Publishing transient competitor rankings or weaknesses as permanent project copy | Reject | Competitor state and result ordering decay quickly; permanent prose would become stale and incentives would shift toward comparison theater. | A dated measurement needs a factual update in a dated record, not evergreen promotional copy. |
| Adding runtime features solely to improve discoverability | Reject | Discoverability does not justify expanding product behavior, permissions, dependencies, privacy exposure, or release risk. | A separate product need is accepted on its own merits in a separate issue and PR. |
| Automatically treating benchmark success, mentions, citations, stars, or checklist completion as product quality | Reject | These are proxies and can improve while correctness, safety, or usefulness does not. | Never without direct claim-evidence and behavior verification. |

## Deferred tactics

| Tactic | Current decision | Why deferred | Activation gate |
|---|---|---|---|
| Repository-owned `robots.txt` for the GitHub Pages project site | Defer | Robots rules are read from the hosted origin root. This repository publishes under `/agy-plugin-cc/` and cannot establish an origin-root policy by adding `site/robots.txt` at the project path. It is also not a security control. | Control of `https://arcobaleno64.github.io/robots.txt`, or migration to an origin whose root this repository controls. |
| Machine-readable files before a canonical site exists | Defer until the site exists | `sitemap.xml`, structured data, and `llms.txt` need a live canonical target and factual visible evidence; publishing them first creates unsupported or stale declarations. | A canonical page is live, its metadata is verified, and every machine-readable claim is traceable to visible or authoritative content. |
| Broad third-party directory expansion | Defer | Directory presence is useful only when the listing is maintained, canonical, and accurately scoped. More listings also create more stale surfaces to audit. | A relevant directory has a verified audience, permits accurate independent-project wording, and has an owner and update path. |

The second row is a sequencing rule, not a claim that these files remain deferred: the canonical site now exists and the repository has separately verified its sitemap, factual SoftwareApplication JSON-LD, and curated `llms.txt`.

## Evidence discipline

- Preserve negative and neutral observations, not only favorable ones.
- Record query text, date, surface, result URLs, subject/evaluator commits, and hashes where the capture format supports them.
- Label self-attested captures as self-attested.
- Keep dated records immutable; select a newer active capture instead of rewriting history.
- Require human review for semantic claim support and safety/capability conclusions.
- Treat cross-surface disagreement as a boundary on the conclusion, not as noise to discard.
- Keep Issue #121 open until its remaining work and the final methodology are independently verified.
