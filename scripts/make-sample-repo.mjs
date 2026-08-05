#!/usr/bin/env node
// Materialize one benchmark corpus case into a disposable git repository, so a
// reviewer has something safe to point `/gemini:review` or a `--write` run at.
//
// The corpus already contains cases with planted defects and a ground-truth file
// naming each one, and bench/lib/corpus.mjs already knows how to lay base/ down
// as a commit and head/ over it as working-tree changes. This is that, minus the
// cleanup, plus a path printed for you to cd into.
//
// Never touches the network, needs no credentials, and writes only inside a new
// temp directory.
import fs from "node:fs";
import process from "node:process";

import { listCases, loadCase, materializeCase } from "../bench/lib/corpus.mjs";

function parseArgs(argv) {
  let caseId = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--case") {
      caseId = argv[i + 1];
      if (!caseId) throw new Error("--case requires a case id.");
      i += 1;
    } else if (argv[i] === "--json") {
      json = true;
    } else if (argv[i] === "--list") {
      console.log(listCases().join("\n"));
      process.exit(0);
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log(
        [
          "Usage: node scripts/make-sample-repo.mjs [--case <id>] [--json]",
          "       node scripts/make-sample-repo.mjs --list",
          "",
          `Cases: ${listCases().join(", ") || "(none)"}`
        ].join("\n")
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return { caseId, json };
}

function main() {
  const { caseId: requested, json } = parseArgs(process.argv.slice(2));
  const cases = listCases();
  if (cases.length === 0) {
    throw new Error("No corpus cases found under bench/corpus/.");
  }

  const caseId = requested ?? cases[0];
  if (!cases.includes(caseId)) {
    throw new Error(`Unknown case "${caseId}". Available: ${cases.join(", ")}`);
  }

  const { truth } = loadCase(caseId);
  const { repoDir, diffText } = materializeCase(caseId);
  const planted = (truth.planted ?? []).map((defect) => ({
    id: defect.id,
    file: defect.file,
    severity: defect.severity ?? null
  }));

  if (json) {
    console.log(JSON.stringify({ caseId, repoDir, plantedDefects: planted, diffChars: diffText.length }, null, 2));
    return;
  }

  console.log(`Sample repository for "${caseId}": ${repoDir}`);
  console.log(`Working-tree diff: ${diffText.length} characters across ${fs.readdirSync(repoDir).length} top-level entries.`);
  console.log("");
  console.log(`Planted defects (${planted.length}) — a good review should find these:`);
  for (const defect of planted) {
    console.log(`  - ${defect.id} (${defect.severity ?? "unrated"}) in ${defect.file}`);
  }
  console.log("");
  console.log("Next:");
  console.log(`  cd ${repoDir}`);
  console.log("  claude --plugin-dir <repo>/plugins/gemini   # then run /gemini:review");
  console.log("");
  console.log(`Delete it when you are done: rm -rf ${repoDir}`);
  console.log(`Full expectations: bench/corpus/${caseId}/ground-truth.json`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
