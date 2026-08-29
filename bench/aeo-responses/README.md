# Captured assistant responses

This directory stores explicitly selected observations for the AEO / GEO benchmark.
The runner reports descriptive counts only. It does **not** turn a small sample into
a visibility rate, health score, trend, or causal claim.

## Active capture set

The runner reads only the manifest passed with `--manifest`, or
`active-manifest.json` when no path is supplied. It never selects files by date,
filename, or "latest" convention.

An active manifest records:

- the exact subject and evaluator Git commits;
- hashes of the question set and rubric;
- whether the session was fresh and whether web search was enabled;
- the provenance level;
- the exact response file and SHA-256 digest for every captured query.
- a hash-verified adjudication file whenever safety or capability captures exist.

`self-attested` is required when an assistant response has no stable external URL.
Use `externally-verifiable` only when every capture has a durable `sourceUrl`.

Example shape:

```json
{
  "schemaVersion": 1,
  "captureSetId": "2026-08-29-fresh-assistant",
  "subjectCommit": "<40-character commit SHA>",
  "evaluatorCommit": "<40-character commit SHA>",
  "provenanceLevel": "self-attested",
  "assistant": "<assistant and version if known>",
  "capturedAt": "2026-08-29",
  "session": {
    "fresh": true,
    "webSearch": "off"
  },
  "querySetHash": "<SHA-256 from the evaluator>",
  "rubricHash": "<SHA-256 from the evaluator>",
  "manualAdjudicationFile": "2026-08-29/MANUAL_ADJUDICATION.md",
  "manualAdjudicationSha256": "<SHA-256 of that file>",
  "captures": [
    {
      "queryId": "BRAND_IDENTITY",
      "responseFile": "2026-08-29/BRAND_IDENTITY.md",
      "responseSha256": "<SHA-256 of the unedited response>"
    }
  ]
}
```

## Capture procedure

1. Freeze the subject commit and evaluator commit.
2. Open a fresh assistant session with no prior project context.
3. Record whether web search is on, off, or unknown.
4. Paste each query exactly as defined in `BENCHMARK_QUERIES`.
5. Save each complete response verbatim; do not correct or annotate it.
6. Calculate the raw file's SHA-256 digest and list it in the manifest.
7. Run `npm run bench:aeo -- --manifest <manifest>`.
8. Manually adjudicate all safety and capability observations against the evidence
   paths embedded in the query definition, then hash and list the adjudication file.

Missing captures remain `unmeasured`; they are not treated as failures.

## Output behavior

`npm run bench:aeo` is read-only and prints a summary. To create a report, provide
an explicit destination:

```sh
npm run bench:aeo -- --manifest bench/aeo-responses/active-manifest.json \
  --output docs/benchmarks/aeo-observation.json
```

The files in `legacy/` predate this manifest contract and are excluded from all
active observations.
