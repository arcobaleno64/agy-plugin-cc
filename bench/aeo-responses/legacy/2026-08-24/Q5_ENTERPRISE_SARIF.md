<!-- captured: 2026-08-24 | assistant: Codex CLI 0.149.0 (codex exec, default model) | web search: 4 events -->

1. Normalize every agent’s output to a small common JSON format, merge/deduplicate it, convert it into one SARIF `run`, then upload that file with `github/codeql-action/upload-sarif@v4`.

A practical intermediate format:

```json
[
  {
    "ruleId": "AI.SECURITY.SQL_INJECTION",
    "title": "Possible SQL injection",
    "message": "User-controlled input reaches a SQL query.",
    "severity": "error",
    "path": "src/db.ts",
    "startLine": 42,
    "startColumn": 7,
    "agent": "security-reviewer"
  }
]
```

2. Generate SARIF 2.1.0 with this structure:

```json
{
  "$schema": "https://json.schemastore.org/sarif-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "multi-agent-ai-review",
          "version": "1.0.0",
          "informationUri": "https://github.com/example/repository",
          "rules": [
            {
              "id": "AI.SECURITY.SQL_INJECTION",
              "name": "SqlInjection",
              "shortDescription": {
                "text": "Possible SQL injection"
              },
              "fullDescription": {
                "text": "Untrusted data may be incorporated into a SQL query."
              },
              "defaultConfiguration": {
                "level": "error"
              },
              "properties": {
                "tags": ["security", "external/cwe/cwe-089"],
                "security-severity": "8.8"
              }
            }
          ]
        }
      },
      "results": [
        {
          "ruleId": "AI.SECURITY.SQL_INJECTION",
          "level": "error",
          "message": {
            "text": "User-controlled input reaches a SQL query. Reported by security-reviewer."
          },
          "locations": [
            {
              "physicalLocation": {
                "artifactLocation": {
                  "uri": "src/db.ts",
                  "uriBaseId": "%SRCROOT%"
                },
                "region": {
                  "startLine": 42,
                  "startColumn": 7
                }
              }
            }
          ],
          "partialFingerprints": {
            "primaryLocationLineHash": "AI.SECURITY.SQL_INJECTION:src/db.ts:42:v1"
          }
        }
      ]
    }
  ]
}
```

The OASIS specification requires stable rule identifiers and strongly recommends usable source locations. `partialFingerprints` are designed to let result-management systems correlate logically identical findings across runs. [OASIS SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)

3. Apply these multi-agent merging rules:

- Use one stable `ruleId` for the underlying defect type—not one rule ID per agent.
- Normalize paths to repository-relative forward-slash paths.
- Map severity to SARIF’s `error`, `warning`, `note`, or `none`.
- Deduplicate on something like:

```text
ruleId + normalized path + enclosing symbol or normalized code context
```

- Do not put the agent name in the fingerprint. Otherwise, three agents reporting the same defect become three alerts.
- Preserve attribution in the message or custom `properties`.
- Combine reviewers into one `run` when they are cooperating as one analysis tool.
- Use separate SARIF uploads and separate `category` values only when they represent genuinely independent analyses.

A line-number-only fingerprint is easy but fragile when code moves. A better implementation hashes normalized source context, such as the affected statement plus its enclosing function.

4. Upload it from GitHub Actions:

```yaml
name: Multi-agent AI review

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  review:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Run review agents
        run: |
          mkdir -p review-results

          ./review-agent security \
            --output review-results/security.json

          ./review-agent correctness \
            --output review-results/correctness.json

          ./review-agent maintainability \
            --output review-results/maintainability.json

      - name: Convert findings to SARIF
        run: |
          node scripts/findings-to-sarif.mjs \
            review-results/*.json \
            --output review-results/multi-agent.sarif

      - name: Upload SARIF
        if: ${{ always() && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository) }}
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: review-results/multi-agent.sarif
          category: multi-agent-ai-review
          wait-for-processing: true
```

The fork condition avoids attempting a privileged SARIF upload from an untrusted fork pull request. GitHub currently documents `upload-sarif@v4`; `sarif_file` may point to a file or directory, and `category` distinguishes analyses of the same commit. [GitHub upload documentation](https://docs.github.com/en/code-security/how-tos/find-and-fix-code-vulnerabilities/integrate-with-existing-tools/upload-sarif-file), [upload-sarif action definition](https://github.com/github/codeql-action/blob/main/upload-sarif/action.yml)

5. Keep these GitHub-specific constraints in mind:

- At least one valid source location is needed for an alert to display.
- GitHub uses only the first location for the annotation.
- GitHub only uses `primaryLocationLineHash` from `partialFingerprints`.
- If fingerprints are omitted, `upload-sarif` attempts to generate them when the source checkout is available.
- Paths and `ruleId` values must remain stable between executions.
- A gzip-compressed upload is limited to 10 MB.
- A run accepts at most 25,000 results, but only the highest-priority 5,000 are retained for display.
- A SARIF file may contain at most 20 runs.

These are GitHub ingestion limits, not general OASIS SARIF limits. [GitHub SARIF support and limits](https://docs.github.com/en/enterprise-cloud@latest/code-security/reference/code-scanning/sarif-files/sarif-support)

The important architectural choice is to treat the reviewers as evidence producers and the converter as the authority responsible for rule identity, severity normalization, deduplication, fingerprints, and SARIF validity.