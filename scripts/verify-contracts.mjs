#!/usr/bin/env node
// Offline contract check for the Gemini plugin manifests and command surface.
// Verifies version lockstep, marketplace/plugin identity, the README install
// command, the plugin source path, and the required slash-command files.
//
// Runs against the repository root by default; pass --root <dir> to target a
// fixture (used by tests/contract.test.mjs). Never touches the network.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PLUGIN_NAME = "gemini";
const REQUIRED_COMMANDS = [
  "setup",
  "review",
  "adversarial-review",
  "rescue",
  "status",
  "result",
  "cancel",
  "transfer"
];

function parseArgs(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      root = argv[i + 1];
      if (!root) {
        throw new Error("--root requires a directory.");
      }
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("Usage: node scripts/verify-contracts.mjs [--root <dir>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${argv[i]}`);
    }
  }
  return { root: path.resolve(root) };
}

function readJson(root, file, errors) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  } catch (error) {
    errors.push(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const errors = [];

  const pkg = readJson(root, "package.json", errors);
  const marketplace = readJson(root, ".claude-plugin/marketplace.json", errors);
  const plugin = readJson(root, `plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json`, errors);

  const expected = pkg?.version;
  if (typeof expected !== "string") {
    errors.push("package.json version must be a string.");
  }

  // 1. Version lockstep across every manifest.
  const marketplacePlugin = Array.isArray(marketplace?.plugins)
    ? marketplace.plugins.find((entry) => entry?.name === PLUGIN_NAME)
    : null;
  const versionChecks = [
    [".claude-plugin/marketplace.json metadata.version", marketplace?.metadata?.version],
    [`.claude-plugin/marketplace.json plugins[${PLUGIN_NAME}].version`, marketplacePlugin?.version],
    [`plugins/${PLUGIN_NAME}/.claude-plugin/plugin.json version`, plugin?.version]
  ];
  for (const [label, actual] of versionChecks) {
    if (expected && actual !== expected) {
      errors.push(`${label}: expected ${expected}, found ${actual ?? "<missing>"}`);
    }
  }

  // 2. Marketplace identity + plugin source path.
  if (!marketplacePlugin) {
    errors.push(`.claude-plugin/marketplace.json must list a plugin named "${PLUGIN_NAME}".`);
  } else {
    const source = marketplacePlugin.source;
    if (source !== `./plugins/${PLUGIN_NAME}`) {
      errors.push(`marketplace plugin source should be "./plugins/${PLUGIN_NAME}", found ${source ?? "<missing>"}.`);
    } else if (!fs.existsSync(path.join(root, "plugins", PLUGIN_NAME))) {
      errors.push(`Plugin source path ${source} does not exist.`);
    }
  }

  // 3. README install command matches "<plugin>@<marketplace>".
  const marketplaceName = marketplace?.name;
  if (typeof marketplaceName === "string") {
    const installCommand = `/plugin install ${PLUGIN_NAME}@${marketplaceName}`;
    let readme = "";
    try {
      readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    } catch {
      errors.push("Cannot read README.md to verify the install command.");
    }
    if (readme && !readme.includes(installCommand)) {
      errors.push(`README.md is missing the install command "${installCommand}".`);
    }
  } else {
    errors.push(".claude-plugin/marketplace.json is missing a string `name`.");
  }

  // 4. Required slash-command files exist.
  for (const command of REQUIRED_COMMANDS) {
    const file = path.join(root, "plugins", PLUGIN_NAME, "commands", `${command}.md`);
    if (!fs.existsSync(file)) {
      errors.push(`Missing required command file: plugins/${PLUGIN_NAME}/commands/${command}.md`);
    }
  }

  // 5. No command places a token beside its `"$ARGUMENTS"` expansion.
  //
  // `$ARGUMENTS` expands to one shell word, so `cmd --background "$ARGUMENTS"`
  // hands the runtime a two-element argv whose second element is a whole flag
  // string. lib/args.mjs only splits that string when it is the entire argv —
  // deliberately, because in a longer argv it cannot be told apart from prompt
  // text — so every flag inside it is read as one positional and dropped.
  // `/gemini:review --base HEAD~1 --scope branch` reported "nothing to review"
  // over a 2045-line diff that way. A command folds its own flags into the same
  // quoted string instead: `review "$ARGUMENTS --background"`.
  for (const command of REQUIRED_COMMANDS) {
    const file = path.join(root, "plugins", PLUGIN_NAME, "commands", `${command}.md`);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!line.includes('"$ARGUMENTS"') || !line.includes(".mjs")) return;
      const [, afterScript = ""] = line.split(/\.mjs"?/);
      const between = afterScript.slice(0, afterScript.indexOf('"$ARGUMENTS"'));
      // The subcommand name is the one bare token allowed before the expansion.
      const extra = between.split(/\s+/).filter(Boolean).slice(1);
      if (extra.length > 0) {
        errors.push(
          `plugins/${PLUGIN_NAME}/commands/${command}.md:${index + 1} passes ${extra.join(" ")} beside "$ARGUMENTS". ` +
            `Fold those flags into the quoted expansion instead (e.g. "$ARGUMENTS --background"), or the runtime discards every flag the user typed.`
        );
      }
    });
  }

  if (errors.length > 0) {
    console.error(`Contract verification failed:\n- ${errors.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Contract verification passed for ${PLUGIN_NAME}@${marketplaceName} v${expected}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
