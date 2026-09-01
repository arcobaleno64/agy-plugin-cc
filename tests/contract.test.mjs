import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUMP = path.join(ROOT, "scripts", "bump-version.mjs");
const VERIFY = path.join(ROOT, "scripts", "verify-contracts.mjs");
const COMMANDS = ["setup", "review", "adversarial-review", "rescue", "status", "result", "cancel", "transfer"];
const ENTRY_INSTALL_COMMANDS = [
  "/plugin marketplace add arcobaleno64/agy-plugin-cc",
  "/plugin install gemini@agy-plugin-cc",
  "/reload-plugins"
];
const CANONICAL_DESCRIPTION = "agy-plugin-cc is a Claude Code companion for running Gemini CLI or Antigravity CLI (agy) as a cross-model task delegate and code reviewer, with pragmatic and adversarial review, MCP tools, and background jobs.";
const CANONICAL_ZH_TW = "`agy-plugin-cc` 是 Claude Code 協作外掛，可透過 Gemini CLI 或 Antigravity CLI（`agy`）進行跨模型任務委派與程式碼審查，並提供務實與對抗性審查、MCP 工具及背景工作。";
const CANONICAL_SITE_TITLE = "agy-plugin-cc — Cross-model review for Claude Code";
const CANONICAL_SITE_URL = "https://arcobaleno64.github.io/agy-plugin-cc/";
const CANONICAL_REPOSITORY_URL = "https://github.com/arcobaleno64/agy-plugin-cc";

function writeJson(filePath, json) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readLines(filePath) {
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
}

function makeFixture(version = "0.5.0") {
  const root = makeTempDir();
  writeJson(path.join(root, "package.json"), { name: "@arcobaleno64/agy-plugin-cc", version });
  writeJson(path.join(root, "package-lock.json"), {
    name: "@arcobaleno64/agy-plugin-cc",
    version,
    lockfileVersion: 3,
    packages: { "": { name: "@arcobaleno64/agy-plugin-cc", version } }
  });
  writeJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json"), { name: "gemini", version });
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "agy-plugin-cc",
    metadata: { version },
    plugins: [{ name: "gemini", version, source: "./plugins/gemini" }]
  });
  fs.writeFileSync(path.join(root, "README.md"), "# agy-plugin-cc\n\n/plugin install gemini@agy-plugin-cc\n");
  for (const command of COMMANDS) {
    const file = path.join(root, "plugins", "gemini", "commands", `${command}.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${command}\n`);
  }
  return root;
}

// --- verify-contracts ---

test("verify-contracts passes on the real repository", () => {
  const result = run("node", [VERIFY], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("public English metadata uses one canonical short description", () => {
  const packageManifest = readJson(path.join(ROOT, "package.json"));
  const marketplace = readJson(path.join(ROOT, ".claude-plugin", "marketplace.json"));
  const pluginManifest = readJson(path.join(ROOT, "plugins", "gemini", ".claude-plugin", "plugin.json"));

  assert.equal(packageManifest.description, CANONICAL_DESCRIPTION);
  assert.equal(marketplace.metadata.description, CANONICAL_DESCRIPTION);
  assert.equal(marketplace.plugins.find(plugin => plugin.name === "gemini")?.description, CANONICAL_DESCRIPTION);
  assert.equal(pluginManifest.description, CANONICAL_DESCRIPTION);

  for (const file of ["README.md", path.join("plugins", "gemini", "README.md")]) {
    assert.equal(readLines(path.join(ROOT, file))[2], CANONICAL_DESCRIPTION, file);
  }
});

test("the Traditional Chinese entry description stays semantically aligned", () => {
  assert.equal(readLines(path.join(ROOT, "README.zh-TW.md"))[2], CANONICAL_ZH_TW);
});

test("the isolated canonical site stays factual, dependency-free, and motion-optional", () => {
  const siteRoot = path.join(ROOT, "site");
  const trackedSite = run("git", ["ls-files", "--", "site"], { cwd: ROOT });
  assert.equal(trackedSite.status, 0, trackedSite.stderr);
  const files = trackedSite.stdout.trim().split(/\r?\n/)
    .filter(Boolean)
    .map((file) => path.relative("site", file))
    .sort();
  assert.deepEqual(files, ["index.html", "sitemap.xml", "styles.css"], "tracked site/ sources must remain an explicit allowlist");

  const html = fs.readFileSync(path.join(siteRoot, "index.html"), "utf8");
  const sitemap = fs.readFileSync(path.join(siteRoot, "sitemap.xml"), "utf8").replace(/\r\n/g, "\n");
  const css = fs.readFileSync(path.join(siteRoot, "styles.css"), "utf8");
  const escapedDescription = CANONICAL_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const jsonLdScripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.ok(html.includes(`<title>${CANONICAL_SITE_TITLE}</title>`));
  assert.ok(html.includes('<link rel="stylesheet" href="styles.css">'));
  assert.equal((html.match(/<link\b/gi) ?? []).length, 2, "site must not load additional link resources");
  assert.match(html, new RegExp(`<meta name="description" content="${escapedDescription}">`));
  assert.ok(html.includes(`<meta property="og:title" content="${CANONICAL_SITE_TITLE}">`));
  assert.match(html, new RegExp(`<meta property="og:description" content="${escapedDescription}">`));
  assert.ok(html.includes(`<link rel="canonical" href="${CANONICAL_SITE_URL}">`));
  assert.ok(html.includes(`<meta property="og:url" content="${CANONICAL_SITE_URL}">`));
  assert.match(html, new RegExp(`<p class="canonical-description">${escapedDescription}</p>`));
  assert.ok(html.includes("<span>agy-plugin-cc</span>"), "structured application name must remain visible");
  assert.ok(html.includes(`href="${CANONICAL_REPOSITORY_URL}"`), "structured repository identity must remain visible");
  assert.equal((html.match(/<script\b/gi) ?? []).length, 1, "site must contain only the reviewed JSON-LD script");
  assert.equal(jsonLdScripts.length, 1, "site must contain one SoftwareApplication JSON-LD block");
  assert.deepEqual(JSON.parse(jsonLdScripts[0][1]), {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "agy-plugin-cc",
    description: CANONICAL_DESCRIPTION,
    url: CANONICAL_SITE_URL,
    sameAs: CANONICAL_REPOSITORY_URL,
  });
  assert.equal(sitemap, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${CANONICAL_SITE_URL}</loc>
  </url>
</urlset>
`);

  for (const command of ENTRY_INSTALL_COMMANDS) {
    assert.match(html, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `site omits ${command}`);
  }
  assert.match(html, /not affiliated with, endorsed by, or sponsored by Google LLC or Anthropic/);
  assert.match(html, /Read-only is an intent, not an enforced filesystem boundary/);
  assert.match(html, /The plugin operates no hosted service/);
  assert.match(html, /<div class="hero-visual" role="img" aria-label="[^"]+">/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  assert.match(html, /<ol class="workflow-steps" role="list">/);
  assert.match(html, /<pre tabindex="0"><code>/);

  assert.doesNotMatch(html, /<(?:iframe|img|picture|video|audio|source|object|embed)\b/i);
  assert.doesNotMatch(html, /\b(?:SEO|AEO|GEO|ranking|ranked|best|leading|official plugin)\b/i);
  assert.doesNotMatch(html, /\b(?:all|every)\s+review commands?\s+are\s+read-only\b/i);
  assert.doesNotMatch(html, /\breview commands?\s+are\s+always\s+read-only\b/i);
  assert.doesNotMatch(html, /\ball\s+reviews?\s+are\s+read-only\b/i);
  assert.doesNotMatch(html, /\b(?:all|every)\s+(?:delegated\s+)?engines?\s+(?:is|are)\s+fully sandboxed\b/i);
  assert.doesNotMatch(css, /@import|url\s*\(\s*["']?https?:/i, "site CSS must not load third-party assets");
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation:\s*none\s*!important/);
  assert.ok(Buffer.byteLength(html) + Buffer.byteLength(sitemap) + Buffer.byteLength(css) < 100 * 1024, "the static site must stay below 100 KiB");
});

test("the canonical site deploys only its allowlisted source from main", () => {
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "pages.yml"), "utf8");
  const normalized = workflow.replace(/\r\n/g, "\n");
  const deployStart = normalized.indexOf("\n  deploy:");
  assert.ok(deployStart >= 0);
  const followingJob = normalized.slice(deployStart + 1).search(/\n  [a-z0-9_-]+:\n/i);
  const deployEnd = followingJob < 0 ? normalized.length : deployStart + 1 + followingJob;
  const deploy = normalized.slice(deployStart, deployEnd);

  assert.ok(normalized.includes('push:\n    branches: [main]\n    paths:\n      - "site/**"\n      - ".github/workflows/pages.yml"'));
  assert.doesNotMatch(normalized, /pull_request(?:_target)?:|schedule:|workflow_dispatch:/);
  assert.ok(normalized.includes("permissions:\n  contents: read\n\nconcurrency:"), "top-level permissions must remain exactly contents: read");
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}\s+# v6\.0\.2/);
  assert.match(workflow, /actions\/configure-pages@[0-9a-f]{40}\s+# v5\.0\.0/);
  assert.match(normalized, /actions\/upload-pages-artifact@[0-9a-f]{40} # v4\.0\.0\n        with:\n          path: site$/m);
  assert.ok(deploy.includes("permissions:\n      pages: write\n      id-token: write\n    environment:"), "deploy permissions must remain exactly pages: write and id-token: write");
  assert.doesNotMatch(deploy, /(?:^|\n)[^\S\n]*(?:-[^\S\n]*)?run:/, "the privileged deploy job must not run repository code");
  assert.deepEqual(
    [...deploy.matchAll(/^\s+(?:-\s+)?uses:\s+(\S+)/gm)].map((match) => match[1]),
    ["actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e"],
    "the privileged deploy job must invoke only the reviewed deploy-pages action",
  );
  assert.match(workflow, /environment:\s*\n\s+name:\s+github-pages\s*\n\s+url:\s+\$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(workflow, /actions\/deploy-pages@[0-9a-f]{40}\s+# v4\.0\.5/);
});

test("root READMEs surface setup and representative workflows before detailed positioning", () => {
  const cases = [
    {
      file: "README.md",
      detailsHeading: "## Installation",
      entryHeading: "## Start here",
      entryEndHeading: "## Why this plugin?",
      releaseHeading: "### Release channel (marketplace follows `main`)",
      markers: [
        "## Start here",
        "You need **Claude Code**, **Node.js ≥ 18**, and **one** supported engine",
        ...ENTRY_INSTALL_COMMANDS,
        "### Three common workflows",
        "/gemini:review --wait",
        "/gemini:adversarial-review --wait",
        "/gemini:rescue --background",
        "## Why this plugin?"
      ]
    },
    {
      file: "README.zh-TW.md",
      detailsHeading: "## 安裝",
      entryHeading: "## 從這裡開始",
      entryEndHeading: "## 為什麼選這個外掛？",
      releaseHeading: "### 發布通道（marketplace 來源追蹤 `main`）",
      markers: [
        "## 從這裡開始",
        "你需要 **Claude Code**、**Node.js ≥ 18**，以及**一個**支援的引擎",
        ...ENTRY_INSTALL_COMMANDS,
        "### 三個常見工作流程",
        "/gemini:review --wait",
        "/gemini:adversarial-review --wait",
        "/gemini:rescue --background",
        "## 為什麼選這個外掛？"
      ]
    }
  ];

  for (const { file, detailsHeading, entryHeading, entryEndHeading, releaseHeading, markers } of cases) {
    const lines = readLines(path.join(ROOT, file));
    const entryStart = lines.indexOf(entryHeading);
    const entryEnd = lines.indexOf(entryEndHeading, entryStart + 1);
    assert.ok(entryStart >= 0 && entryEnd > entryStart, `${file} does not retain its bounded entry section`);

    const entryText = lines.slice(entryStart, entryEnd + 1).join("\n");
    let cursor = -1;
    for (const marker of markers) {
      const index = entryText.indexOf(marker, cursor + 1);
      assert.ok(index > cursor, `${file} does not surface ${JSON.stringify(marker)} in the expected order`);
      cursor = index;
    }

    const detailsIndex = lines.indexOf(detailsHeading, entryEnd + 1);
    const releaseIndex = lines.indexOf(releaseHeading, detailsIndex + 1);
    const releaseFenceStart = lines.indexOf("```", releaseIndex + 1);
    const releaseFenceEnd = lines.indexOf("```", releaseFenceStart + 1);
    assert.ok(detailsIndex > entryEnd, `${file} does not retain its detailed installation section`);
    assert.ok(releaseIndex > detailsIndex && releaseFenceStart > releaseIndex && releaseFenceEnd > releaseFenceStart, `${file} does not retain its bounded release-channel command block`);

    const releaseCommands = lines.slice(releaseFenceStart + 1, releaseFenceEnd).filter((line) => line.startsWith("/"));
    assert.deepEqual(releaseCommands, ENTRY_INSTALL_COMMANDS, `${file} detailed release-channel commands drifted from the entry commands`);
  }
});

test("verify-contracts passes on a well-formed fixture", () => {
  const result = run("node", [VERIFY, "--root", makeFixture()], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});

test("verify-contracts fails when a manifest version is out of sync", () => {
  const root = makeFixture();
  const pluginFile = path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json");
  writeJson(pluginFile, { ...readJson(pluginFile), version: "9.9.9" });

  const result = run("node", [VERIFY, "--root", root], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /plugin\.json version/);
});

test("verify-contracts fails when a required command file is missing", () => {
  const root = makeFixture();
  fs.rmSync(path.join(root, "plugins", "gemini", "commands", "cancel.md"));

  const result = run("node", [VERIFY, "--root", root], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cancel\.md/);
});

test("verify-contracts fails when the README install command is missing", () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, "README.md"), "# no install command here\n");

  const result = run("node", [VERIFY, "--root", root], { cwd: ROOT });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install command/);
});

// --- CI workflow gates ---

// Both workflows run `claude plugin validate` against a pinned Claude Code. If
// the pins drift apart the PR gate and the release gate stop validating against
// the same schema, and nothing else would report it.
test("both workflows pin the same claude-code version for plugin validation", () => {
  const workflows = ["pull-request-ci.yml", "release.yml"].map((name) => ({
    name,
    text: fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8")
  }));

  const pins = workflows.map(({ name, text }) => {
    const match = text.match(/@anthropic-ai\/claude-code@(\S+)/);
    assert.ok(match, `${name} does not install a pinned @anthropic-ai/claude-code`);
    return match[1];
  });
  assert.equal(pins[0], pins[1], "workflow pins disagree");

  for (const { name, text } of workflows) {
    assert.match(text, /claude plugin validate \.\/plugins\/gemini --strict/, `${name} misses the plugin validate step`);
    assert.match(text, /claude plugin validate \. --strict/, `${name} misses the marketplace validate step`);
  }
});

// Split a workflow's `jobs:` mapping into { name, text } blocks. The repo has no
// dependencies and will not take a YAML parser for one test, and the shapes
// asserted below are lexical anyway.
function releaseJobs() {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === "jobs:");
  assert.ok(start !== -1, "release.yml has no jobs: block");

  // `text` keeps everything; `code` drops whole-line comments, so the assertions
  // below read the job's steps rather than the prose explaining them — a comment
  // saying "no npm ci here" must not read as an npm step.
  const jobs = [];
  for (const line of lines.slice(start + 1)) {
    const header = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (header) {
      jobs.push({ name: header[1], text: "", code: "" });
      continue;
    }
    if (!jobs.length) continue;
    const job = jobs[jobs.length - 1];
    job.text += `${line}\n`;
    if (!line.trimStart().startsWith("#")) job.code += `${line}\n`;
  }
  assert.ok(jobs.length >= 2, "release.yml should have a verify job and a publish job");
  return jobs;
}

// Whoever can push a `v*` tag chooses what `npm test`, `npm ci`'s lifecycle
// scripts, and every `npm run` on that tag execute. A job holding a token that
// can publish must therefore run none of it. This is one `needs:` away from
// being undone by a merge, and the damage would not show up in any output.
test("the release job that can write runs no code from the tag", () => {
  const writers = releaseJobs().filter(({ code }) => /permissions:[\s\S]*?contents:\s*write/.test(code));
  assert.equal(writers.length, 1, "exactly one release job should hold contents: write");

  const [publish] = writers;
  assert.doesNotMatch(publish.code, /uses:\s*actions\/checkout/, `${publish.name} checks out the tag it is publishing`);
  assert.doesNotMatch(publish.code, /\bnpm\b/, `${publish.name} runs npm, which executes tag-controlled code`);
  assert.match(publish.code, /needs:\s*verify/, `${publish.name} must publish only after the verifying job passed`);
});

test("the release workflow defaults to a read-only token", () => {
  const text = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  // The top-level block, before `jobs:`. A workflow-wide `contents: write` would
  // hand the write token to every job including the one running the tag's tests.
  const preamble = text.slice(0, text.indexOf("jobs:"));
  assert.match(preamble, /permissions:\s*\n\s*contents:\s*read/);
});

// --- bump-version (ported from upstream, adapted for the gemini layout) ---

test("bump-version updates every manifest and --check detects drift", () => {
  const root = makeFixture("0.5.0");

  const bumped = run("node", [BUMP, "--root", root, "1.2.3"], { cwd: ROOT });
  assert.equal(bumped.status, 0, bumped.stderr);
  assert.equal(readJson(path.join(root, "package.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "1.2.3");
  assert.equal(readJson(path.join(root, "plugins", "gemini", ".claude-plugin", "plugin.json")).version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).metadata.version, "1.2.3");
  assert.equal(readJson(path.join(root, ".claude-plugin", "marketplace.json")).plugins[0].version, "1.2.3");

  // Desync package.json and confirm --check reports the mismatch.
  writeJson(path.join(root, "package.json"), { name: "@arcobaleno64/agy-plugin-cc", version: "1.2.4" });
  const checked = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /out of sync/i);
});

// A release whose manifests all agree and whose changelog says nothing about the
// version passes every other gate: the four manifests are mechanically consistent,
// contracts verify, and the release workflow's tag assertion compares the tag to
// package.json — which was bumped. The one artifact that tells a user what changed
// was the only one nothing checked. Surfaced by a code review of the v0.17.3
// release commit, which did have its entry.
test("--check fails when the changelog has no entry for the version", () => {
  const root = makeFixture("1.2.3");
  const changelog = path.join(root, "plugins", "gemini", "CHANGELOG.md");
  fs.mkdirSync(path.dirname(changelog), { recursive: true });
  fs.writeFileSync(changelog, "# Changelog\n\n## 1.2.2 — 2026-01-01 — something else\n");

  const missing = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(missing.status, 0, "a release with no changelog entry must not pass");
  assert.match(missing.stderr, /no `## 1\.2\.3` entry/);

  fs.appendFileSync(changelog, "\n## 1.2.3 — 2026-01-02 — the entry\n");
  const present = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.equal(present.status, 0, present.stderr);
  assert.match(present.stdout, /changelog has an entry/);
});

// A near-miss must not satisfy it: `## 1.2.30` starts with the same characters as
// 1.2.3, and a prefix match would have accepted the wrong release's entry.
test("--check does not accept a longer version as the entry", () => {
  const root = makeFixture("1.2.3");
  const changelog = path.join(root, "plugins", "gemini", "CHANGELOG.md");
  fs.mkdirSync(path.dirname(changelog), { recursive: true });
  fs.writeFileSync(changelog, "# Changelog\n\n## 1.2.30 — 2026-01-01 — a different release\n");

  const result = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.notEqual(result.status, 0);
});

// The fixtures do not ship a changelog, and a missing file is not a version
// metadata problem — the existing bump-version test would otherwise start failing
// for a reason unrelated to what it pins.
test("--check stays silent about a changelog that does not exist", () => {
  const root = makeFixture("1.2.3");
  const result = run("node", [BUMP, "--root", root, "--check"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
});

// Job state lives under CLAUDE_PLUGIN_DATA, which Claude Code sets in the
// environment its commands run in — so a suite run from inside a session
// inherited the real one, and every temp workspace a test created left a
// permanent state directory in the developer's own plugin data. Nothing reclaims
// them: pruneJobStore bounds the jobs inside a workspace, and nothing bounds the
// number of workspaces. Measured on the machine this was found on, 9626 of 9651
// directories under that state root were named `gemini-plugin-test*`.
//
// Probed through a child process rather than read off this one's environment, so
// the guard says the same thing whether or not the suite was launched via
// `npm test`.
test("npm test keeps job state out of the developer's plugin data", () => {
  const pkg = readJson(path.join(ROOT, "package.json"));
  assert.match(pkg.scripts.test, /--import \.\/tests\/isolate-state\.mjs/, "npm test must preload the state isolator");

  const inherited = path.join(ROOT, "not-a-real-plugin-data-dir");
  const probe = run(
    process.execPath,
    ["--import", "./tests/isolate-state.mjs", "-e", "console.log(JSON.stringify([process.env.CLAUDE_PLUGIN_DATA, process.env.GEMINI_COMPANION_DATA]))"],
    { cwd: ROOT, env: { ...process.env, CLAUDE_PLUGIN_DATA: inherited, GEMINI_COMPANION_DATA: inherited } }
  );
  assert.equal(probe.status, 0, probe.stderr);

  // Both names, not one: state.mjs reads GEMINI_COMPANION_DATA first, so leaving
  // a developer's own override standing would defeat the redirect.
  for (const value of JSON.parse(probe.stdout)) {
    assert.notEqual(value, inherited, "the inherited plugin data dir must not survive the preload");
    assert.equal(path.dirname(value), os.tmpdir(), "state must be redirected into a fresh temp directory");
  }
});
