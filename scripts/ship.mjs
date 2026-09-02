#!/usr/bin/env node
// The mechanical half of the ship sequence: changelog insert, bump, gates,
// commit, push, PR. It stops at the PR on purpose. Everything after that --
// triaging review findings, reading CI failures, deciding to merge -- needs a
// judgement this script cannot make, and pretending otherwise would turn a
// blocking finding into an exit code nobody reads.
//
// The prose is the caller's job. This script takes it as files rather than
// generating it, because a changelog entry summarising its own diff is the one
// part of a release that has to actually be thought about.
//
//   node scripts/ship.mjs --commit .ship/commit.txt \
//                         --changelog .ship/changelog.md --version 0.24.4 \
//                         --pr .ship/pr.md --title "fix(x): ..."
//
// Exit codes are per-step so a caller can branch on the failure instead of
// re-reading the log. See EXIT below.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const EXIT = {
  ok: 0,
  usage: 2,
  // Preflight -- nothing has been written yet.
  onDefaultBranch: 10,
  nothingToCommit: 11,
  missingInput: 12,
  ghUnavailable: 13,
  // Release metadata.
  changelogInsertFailed: 20,
  bumpFailed: 21,
  // Gates. Split apart because "tests are red" and "you forgot the changelog"
  // are different problems with different next steps.
  testsFailed: 30,
  versionCheckFailed: 31,
  contractsFailed: 32,
  // Publishing.
  commitFailed: 40,
  pushFailed: 41,
  prFailed: 42
};

const CHANGELOG_FILE = "plugins/gemini/CHANGELOG.md";
const DEFAULT_BRANCHES = new Set(["main", "master"]);

class ShipError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function usage() {
  return [
    "Usage: node scripts/ship.mjs --commit <file> [options]",
    "",
    "  --commit <file>     Commit message (required). Read as-is, never generated.",
    "  --changelog <file>  Changelog entry to insert above the newest one.",
    "                      Required with --version; ignored without it.",
    "  --version <x.y.z>   Bump every manifest to this version. Omit for a",
    "                      release-less ship (docs, tests, a follow-up fix).",
    "  --pr <file>         PR body. New PR when the branch has none; posted as a",
    "                      comment when it already has one.",
    "  --title <text>      PR title. Defaults to the commit subject.",
    "  --no-push           Stop after the commit.",
    "  --dry-run           Report what each step would do and change nothing.",
    "",
    "Stops at the PR. Review triage and CI reading are deliberately left out."
  ].join("\n");
}

export function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ShipError(EXIT.usage, `${arg} needs a value.`);
      }
      i += 1;
      return value;
    };
    switch (arg) {
      case "--help": case "-h": options.help = true; break;
      case "--commit": options.commitFile = take(); break;
      case "--changelog": options.changelogFile = take(); break;
      case "--pr": options.prFile = take(); break;
      case "--title": options.title = take(); break;
      case "--version": options.version = take(); break;
      case "--root": options.root = take(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--no-push": options.noPush = true; break;
      default: throw new ShipError(EXIT.usage, `Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

// Insert above the first `## ` heading rather than appending: the changelog is
// newest-first, so a fragment appended to the end is invisible to every reader
// and to `bump-version --check`, which only scans headings.
export function insertChangelogEntry(existing, fragment) {
  const entry = `${fragment.trim()}\n`;
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith("## "));
  if (index === -1) {
    throw new ShipError(
      EXIT.changelogInsertFailed,
      `${CHANGELOG_FILE} has no \`## \` heading to insert above. Refusing to guess where the entry belongs.`
    );
  }
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  // Each preceding line keeps its own terminator. Joining them and relying on
  // `entry` to supply the break swallows the blank line under the title, gluing
  // the new heading to it -- and every later release inherits the damage.
  const before = lines.slice(0, index).map((line) => `${line}\n`).join("");
  const after = lines.slice(index).join("\n");
  return `${before}${entry}\n${after}`.split(/\r?\n/).join(eol);
}

// Compared token by token rather than by a regex built from the version. Escaping
// `.` and leaving `\` unescaped is a real hole (CodeQL js/incomplete-sanitization
// and js/regex-injection, both high, on the first version of this), and the
// answer here is not a better escape -- it is not building a pattern out of an
// argument at all. Matches bump-version --check, which splits on whitespace and
// compares the second token.
export function hasChangelogHeading(text, version) {
  return text.split(/\r?\n/).some((line) => {
    if (!line.startsWith("## ")) return false;
    const token = line.split(/\s+/)[1];
    return token === version || token === `v${version}`;
  });
}

export function summariseTests(output) {
  const parts = ["tests", "pass", "fail", "skipped"].map((label) => {
    const value = output.match(new RegExp(`^[^\\n]*\\b${label}\\s+(\\d+)\\s*$`, "m"))?.[1];
    return value === undefined ? null : `${label} ${value}`;
  }).filter(Boolean);
  return parts.length ? parts.join(", ") : "tests passed";
}

export function tail(text, lines) {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

function run(command, args, { root, shell = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "pipe", shell });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    // A command that never started produces no stderr, and reporting a bare
    // "failed" for it sends the reader looking at their own changes. Node
    // refuses to spawn a .cmd without a shell on Windows (EINVAL), which is
    // exactly how this surfaced.
    stderr: (result.stderr ?? "").trim() || (result.error ? `${command}: ${result.error.message}` : "")
  };
}

// npm is a .cmd on Windows, which node refuses to spawn without a shell, and
// passing args through a shell is deprecated (DEP0190) because they are
// concatenated rather than escaped. Running npm's own entry script under this
// node avoids both: no shell, no .cmd, and the same npm that is on PATH.
export function npmCliCandidates(execPath, env = {}) {
  const dir = path.dirname(execPath);
  return [
    // Set when ship itself was started by an npm script.
    env.npm_execpath && env.npm_execpath.endsWith(".js") ? env.npm_execpath : null,
    path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"),          // Windows layout
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js") // POSIX prefix layout
  ].filter(Boolean);
}

function runNpm(args, options) {
  const cli = npmCliCandidates(process.execPath, process.env).find((candidate) => fs.existsSync(candidate));
  if (cli) return run(process.execPath, [cli, ...args], options);
  // No npm entry script where it should be -- an unusual install rather than a
  // broken one, so fall back rather than fail. The argument lists are constants
  // defined in this file; nothing from the caller reaches the shell.
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return run(npm, args, { ...options, shell: process.platform === "win32" });
}

function mustRun(code, message, command, args, options) {
  const result = run(command, args, options);
  if (!result.ok) {
    throw new ShipError(code, message, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
  return result;
}

function readInput(root, file, label) {
  const resolved = path.resolve(root, file);
  if (!fs.existsSync(resolved)) {
    throw new ShipError(EXIT.missingInput, `${label} file not found: ${file}`);
  }
  const text = fs.readFileSync(resolved, "utf8").trim();
  if (!text) {
    throw new ShipError(EXIT.missingInput, `${label} file is empty: ${file}. An empty ${label} is never what was meant.`);
  }
  return text;
}

function step(label) {
  process.stdout.write(`\n== ${label}\n`);
}

function preflight(options) {
  step("preflight");
  const branch = mustRun(EXIT.usage, "Not a git repository.", "git", ["branch", "--show-current"], options).stdout;
  // Detached HEAD prints an empty name and exits 0. Left unchecked the run
  // reaches `git push -u origin ""` and fails there -- after a commit that is
  // orphaned the moment the user checks out a branch.
  if (!branch) {
    throw new ShipError(
      EXIT.onDefaultBranch,
      "HEAD is detached, so there is no branch to push. Check out a branch first; a commit made here is orphaned as soon as you leave it."
    );
  }
  if (DEFAULT_BRANCHES.has(branch)) {
    throw new ShipError(
      EXIT.onDefaultBranch,
      `On ${branch}. Ship works through a branch and a PR; committing here bypasses both.`
    );
  }
  // What goes into the commit is the caller's decision, not this script's. It
  // stages nothing on their behalf -- an `add -u` would silently drop a new file
  // (this script's first dry run dropped itself), and an `add -A` would sweep in
  // whatever else happens to be sitting in the tree. Both are the kind of error a
  // reviewer sees only after the push.
  const staged = mustRun(EXIT.usage, "git diff failed.", "git", ["diff", "--cached", "--name-only"], options).stdout;
  const stagedFiles = staged.split("\n").filter((line) => line.trim());
  if (stagedFiles.length === 0 && !options.version) {
    throw new ShipError(
      EXIT.nothingToCommit,
      "Nothing staged, and no --version to bump. Stage what belongs in this commit first (`git add <paths>`), then run ship."
    );
  }
  if (options.prFile && !run("gh", ["auth", "status"], options).ok) {
    throw new ShipError(EXIT.ghUnavailable, "gh is not authenticated, so the PR step would fail after the push. Run `gh auth login`.");
  }
  // The gates run against the working tree; the commit is the index. An unstaged
  // edit can hold the tests green for a commit that is red in CI, and this script
  // will not stage it for you -- so say so rather than reporting a green run that
  // tested something other than what was pushed.
  const unstaged = run("git", ["diff", "--name-only"], options).stdout.split("\n").filter((line) => line.trim());
  console.log(`branch ${branch}, ${stagedFiles.length} staged file(s)`);
  if (unstaged.length > 0) {
    console.log(
      `warning: ${unstaged.length} unstaged change(s) -- the gates below test the working tree, `
      + `but the commit is the index, so a green run here does not prove the pushed commit is green:\n  `
      + unstaged.slice(0, 10).join("\n  ")
      + (unstaged.length > 10 ? `\n  ...and ${unstaged.length - 10} more` : "")
    );
  }
  return { branch };
}

function applyChangelog(options) {
  if (!options.version) return [];
  step(`changelog entry for ${options.version}`);
  const fragment = readInput(options.root, options.changelogFile, "changelog");
  const target = path.resolve(options.root, CHANGELOG_FILE);
  const existing = fs.readFileSync(target, "utf8");
  if (hasChangelogHeading(existing, options.version)) {
    console.log(`already has a \`## ${options.version}\` heading; leaving it alone`);
    return [];
  }
  const next = insertChangelogEntry(existing, fragment);
  if (options.dryRun) {
    console.log(`would insert ${fragment.split("\n").length} line(s) into ${CHANGELOG_FILE}`);
    return [];
  }
  fs.writeFileSync(target, next, "utf8");
  console.log(`inserted into ${CHANGELOG_FILE}`);
  // Returned so commit() stages it. bump-version rewrites only the four JSON
  // manifests and never the changelog, so nothing else would, and check-version
  // reads the working tree rather than the index -- a release commit could go out
  // with the entry written on disk and absent from the diff.
  return [CHANGELOG_FILE];
}

function bump(options) {
  if (!options.version) {
    step("version");
    console.log("no --version; shipping without a release");
    return [];
  }
  step(`bump to ${options.version}`);
  if (options.dryRun) {
    console.log("would run bump-version");
    return [];
  }
  const result = mustRun(EXIT.bumpFailed, `bump-version rejected ${options.version}.`,
    process.execPath, ["scripts/bump-version.mjs", options.version], options);
  console.log(result.stdout);
  return bumpedFiles(result.stdout);
}

// bump-version names the manifests it rewrote. Parsing that beats keeping a
// second copy of the list here, which would go stale the first time a manifest
// is added and stage nothing while still reporting success.
export function bumpedFiles(output) {
  const listed = output.match(/^Set version metadata to [^:]+: (.+)\.$/m)?.[1];
  if (!listed || /^no files changed$/.test(listed)) return [];
  return listed.split(",").map((file) => file.trim()).filter(Boolean);
}

// Run after the bump, never before: the version is an assertion target for
// check-version and for a doc test that pins the release row, so a green run
// from before the bump has not tested this commit.
function gates(options) {
  step("gates");
  if (options.dryRun) {
    console.log("would run: npm test, check-version, verify-contracts");
    return;
  }
  const test = runNpm(["test"], options);
  if (!test.ok) {
    const output = `${test.stdout}\n${test.stderr}`;
    // Matched on the test's own name, not on the filename: the string
    // "docs/COMPARISON.md" appears in other suites' captured output, and a hint
    // pointing at the wrong file is worse than none.
    const hint = /comparison and parity docs/i.test(output)
      ? "\n\nHint: docs/COMPARISON.md pins this project's release row. Refresh the version AND the date in that row -- both are asserted, and a stale date is the easier one to miss."
      : "";
    throw new ShipError(EXIT.testsFailed, `Tests failed.${hint}`, tail(output, 40).slice(-4000));
  }
  console.log(summariseTests(test.stdout));
  const version = runNpm(["run", "check-version"], options);
  if (!version.ok) {
    throw new ShipError(EXIT.versionCheckFailed, "check-version failed.", tail(`${version.stdout}\n${version.stderr}`, 20));
  }
  const contracts = runNpm(["run", "verify-contracts"], options);
  if (!contracts.ok) {
    throw new ShipError(EXIT.contractsFailed, "verify-contracts failed.", tail(`${contracts.stdout}\n${contracts.stderr}`, 20));
  }
  console.log("check-version and verify-contracts pass");
}

function commit(options, writtenFiles) {
  step("commit");
  const messageFile = path.resolve(options.root, options.commitFile);
  if (options.dryRun) {
    console.log(`would stage ${writtenFiles.length} file(s) this script wrote, then commit with the message in ${options.commitFile}`);
    return null;
  }
  // Stage only what this script itself wrote. Everything else was staged by the
  // caller, deliberately, before ship ran.
  if (writtenFiles.length > 0) {
    mustRun(EXIT.commitFailed, "git add failed.", "git", ["add", "--", ...writtenFiles], options);
  }
  const result = run("git", ["commit", "-F", messageFile], options);
  if (!result.ok) {
    throw new ShipError(
      EXIT.commitFailed,
      "git commit failed. A rejecting hook is a reason to fix the cause, not to pass --no-verify.",
      `${result.stdout}\n${result.stderr}`.trim()
    );
  }
  const sha = run("git", ["rev-parse", "--short", "HEAD"], options).stdout;
  const subject = run("git", ["log", "-1", "--pretty=%s"], options).stdout;
  console.log(`${sha} ${subject}`);
  return { sha, subject };
}

function push(options, branch) {
  if (options.noPush) {
    step("push");
    console.log("skipped (--no-push)");
    return false;
  }
  step("push");
  if (options.dryRun) {
    console.log(`would push ${branch} to origin`);
    return false;
  }
  mustRun(EXIT.pushFailed, `Failed to push ${branch}.`, "git", ["push", "-u", "origin", branch], options);
  console.log(`pushed ${branch}`);
  return true;
}

function pullRequest(options, branch, subject) {
  if (!options.prFile) return null;
  step("pull request");
  readInput(options.root, options.prFile, "PR body");
  const bodyFile = path.resolve(options.root, options.prFile);
  const existing = run("gh", ["pr", "list", "--head", branch, "--json", "number", "--jq", ".[].number"], options);
  // A gh failure here is not "no PR exists". Treating it as one makes the script
  // call `gh pr create` on a branch that already has an open PR, which fails --
  // after the push has already landed.
  if (!existing.ok) {
    throw new ShipError(
      EXIT.prFailed,
      `Could not list PRs for ${branch}, so it is unknown whether one is already open. The push succeeded; open or comment on the PR by hand.`,
      existing.stderr
    );
  }
  const number = existing.stdout.split("\n")[0]?.trim();
  if (options.dryRun) {
    console.log(number ? `would comment on PR #${number}` : `would open a PR titled ${JSON.stringify(options.title ?? subject ?? "")}`);
    return null;
  }
  // An open PR was already updated by the push; a second `create` would fail,
  // and a comment is what tells the reviewer what arrived since they last looked.
  if (number) {
    const result = mustRun(EXIT.prFailed, `Failed to comment on PR #${number}.`,
      "gh", ["pr", "comment", number, "--body-file", bodyFile], options);
    console.log(`commented on #${number}`);
    return { url: result.stdout, updated: true };
  }
  const title = options.title ?? subject;
  if (!title) {
    throw new ShipError(EXIT.prFailed, "No PR title: pass --title, or let the commit supply its subject.");
  }
  const result = mustRun(EXIT.prFailed, "Failed to open the PR.",
    "gh", ["pr", "create", "--title", title, "--body-file", bodyFile], options);
  const url = result.stdout.split("\n").filter(Boolean).pop() ?? "";
  console.log(`opened ${url}`);
  return { url, updated: false };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.commitFile) {
    throw new ShipError(EXIT.usage, `Missing --commit.\n\n${usage()}`);
  }
  if (options.version && !options.changelogFile) {
    throw new ShipError(EXIT.usage, "--version needs --changelog: a release with no entry tells the user nothing about what changed.");
  }
  readInput(options.root, options.commitFile, "commit message");
  if (options.prFile) readInput(options.root, options.prFile, "PR body");

  const { branch } = preflight(options);
  const written = [...applyChangelog(options), ...bump(options)];
  gates(options);
  const committed = commit(options, written);
  const pushed = push(options, branch);
  const pr = pushed || options.dryRun ? pullRequest(options, branch, committed?.subject) : null;

  step("done");
  console.log(`commit  ${committed ? `${committed.sha} ${committed.subject}` : "(dry run)"}`);
  console.log(`pr      ${pr ? `${pr.url} (${pr.updated ? "updated" : "new"})` : "(none)"}`);
  console.log("\nNot done by this script, on purpose: code review, CI, merge.");
}

const SELF_PATH = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === SELF_PATH) {
  try {
    main();
  } catch (error) {
    if (error instanceof ShipError) {
      console.error(`\n${error.message}`);
      if (error.detail) console.error(`\n${error.detail}`);
      process.exit(error.code);
    }
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  }
}
