# Captured assistant responses

One file per benchmark query in `scripts/aeo-benchmark.mjs`, named `<QUERY_ID>.md`.
Each holds the answer a real assistant gave to that query's exact wording, pasted
verbatim. Nothing here is written by this repository.

The first line must be a provenance comment:

```
<!-- captured: 2026-08-24 | assistant: ChatGPT 5 -->
```

`scripts/aeo-benchmark.mjs` refuses to score a file without one. That is deliberate:
the runner used to score a mock literal stored a few lines below the keyword list it
was scored against, which made the reported "AEO Health Score" a fact about this
repository rather than about any assistant. A fixture that cannot say which assistant
produced it reintroduces exactly that.

## Capturing one

1. Open a fresh session with the assistant — no prior context about this project,
   or the answer measures the conversation rather than the assistant's own index.
2. Paste the query's `query` string verbatim from `BENCHMARK_QUERIES`.
3. Save the full reply to `<QUERY_ID>.md` under a provenance line. Do not edit the
   body, including the parts that say nothing about this project.
4. Run `npm run bench:aeo`.

## What the score does and does not mean

Rates are over captured queries only, and a query with no file here is reported as
unmeasured rather than failed. A high score over one captured response is a fact
about one answer from one assistant on one day, not a trend.
