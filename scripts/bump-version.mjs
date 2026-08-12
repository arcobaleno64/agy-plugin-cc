#!/usr/bin/env node
// Adapted from openai/codex-plugin-cc (scripts/bump-version.mjs, Apache-2.0) for
// the Gemini plugin layout. Keeps every manifest version in lockstep.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PLUGIN_NAME = "gemini";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const TARGETS = [
  {
    file: "package.json",
    values: [{ label: "version", get: (json) => json.version, set: (json, version) => { json.version = version; } }]
  },
  {
    file: "package-lock.json",
    values: [
      { label: "version", get: (json) => json.version, set: (json, version) => { json.version = version; } },
      {
        label: "packages[\"\"].version",
        get: (json) => json.packages?.[""]?.version,
        set: (json, version) => {
          requireObject(json.packages?.[""], "package-lock.json packages[\"\"]");
          json.packages[""].version = version;
        }
      }
    ]
  },
  {
    file: `plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json`,
    values: [{ label: "version", get: (json) => json.version, set: (json, version) => { json.version = version; } }]
  },
  {
    file: ".claude-plugin/marketplace.json",
    values: [
      {
        label: "metadata.version",
        get: (json) => json.metadata?.version,
        set: (json, version) => {
          requireObject(json.metadata, ".claude-plugin/marketplace.json metadata");
          json.metadata.version = version;
        }
      },
      {
        label: `plugins[${PLUGIN_NAME}].version`,
        get: (json) => findMarketplacePlugin(json).version,
        set: (json, version) => {
          findMarketplacePlugin(json).version = version;
        }
      }
    ]
  }
];

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs <version>",
    "  node scripts/bump-version.mjs --check [version]",
    "",
    "Options:",
    "  --check       Verify manifest versions. Uses package.json when version is omitted.",
    "  --root <dir>  Run against a different repository root.",
    "  --help        Print this help."
  ].join("\n");
}

function parseArgs(argv) {
  const options = { check: false, root: process.cwd(), version: null };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--root") {
      const root = argv[i + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      options.root = root;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.version) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    } else {
      options.version = arg;
    }
  }

  options.root = path.resolve(options.root);
  return options;
}

function validateVersion(version) {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Expected a semver-like version such as 1.0.3, got: ${version}`);
  }
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
}

function findMarketplacePlugin(json) {
  const plugin = json.plugins?.find((entry) => entry?.name === PLUGIN_NAME);
  requireObject(plugin, `.claude-plugin/marketplace.json plugins[${PLUGIN_NAME}]`);
  return plugin;
}

function readJson(root, file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

function writeJson(root, file, json) {
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(json, null, 2)}\n`);
}

function readPackageVersion(root) {
  const packageJson = readJson(root, "package.json");
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  validateVersion(packageJson.version);
  return packageJson.version;
}

function checkVersions(root, expectedVersion) {
  const mismatches = [];
  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    for (const value of target.values) {
      const actual = value.get(json);
      if (actual !== expectedVersion) {
        mismatches.push(`${target.file} ${value.label}: expected ${expectedVersion}, found ${actual ?? "<missing>"}`);
      }
    }
  }
  return mismatches;
}

const CHANGELOG_FILE = `plugins/${PLUGIN_NAME}/CHANGELOG.md`;

// A release whose manifests all agree and whose changelog says nothing about the
// version passes every other gate in this repository: the four manifests are
// mechanically consistent, contracts verify, and the tag assertion in the release
// workflow compares the tag to package.json — which was bumped. The one artifact
// that tells a user what changed is the only one nothing checks.
//
// Only enforced when the file exists. A missing changelog is not a version-metadata
// problem (the bump-version fixtures do not ship one), and a guard that a caller
// can satisfy by deleting the file it guards is not worth the branch.
function checkChangelogEntry(root, expectedVersion) {
  const file = path.join(root, CHANGELOG_FILE);
  if (!fs.existsSync(file)) return null;
  const headings = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.startsWith("## "));
  // Token comparison, not a constructed regex. `## 0.17.3 — 2026-08-12 — title`
  // splits to ["##", "0.17.3", …], so the version is element 1 and an exact match
  // rejects `## 0.17.30` for free.
  //
  // The first version of this built `new RegExp(...)` from the version string and
  // escaped only dots. CodeQL was right about both halves of that: the escaping was
  // incomplete (backslashes survived) and the pattern came from a command-line
  // argument. Hardening the escape would have kept a regex nobody needed — the
  // question here was only ever "is this token equal to that one".
  const found = headings.some((line) => {
    const token = line.split(/\s+/)[1];
    return token === expectedVersion || token === `v${expectedVersion}`;
  });
  if (found) return null;
  return `${CHANGELOG_FILE}: no \`## ${expectedVersion}\` entry. The manifests agree, so nothing else would have caught this — a release with no changelog entry tells the user nothing about what changed.`;
}

function bumpVersion(root, version) {
  const changedFiles = [];
  for (const target of TARGETS) {
    const json = readJson(root, target.file);
    const before = JSON.stringify(json);
    for (const value of target.values) {
      value.set(json, version);
    }
    if (JSON.stringify(json) !== before) {
      writeJson(root, target.file, json);
      changedFiles.push(target.file);
    }
  }
  return changedFiles;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const version = options.version ?? (options.check ? readPackageVersion(options.root) : null);
  if (!version) {
    throw new Error(`Missing version.\n\n${usage()}`);
  }
  validateVersion(version);

  if (options.check) {
    const mismatches = checkVersions(options.root, version);
    if (mismatches.length > 0) {
      throw new Error(`Version metadata is out of sync:\n${mismatches.join("\n")}`);
    }
    const missingEntry = checkChangelogEntry(options.root, version);
    if (missingEntry) {
      throw new Error(missingEntry);
    }
    console.log(`All version metadata matches ${version}, and the changelog has an entry for it.`);
    return;
  }

  const changedFiles = bumpVersion(options.root, version);
  const touched = changedFiles.length > 0 ? changedFiles.join(", ") : "no files changed";
  console.log(`Set version metadata to ${version}: ${touched}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
