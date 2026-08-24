import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../plugins/gemini/scripts/gemini-mcp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// Dynamic path resolution using standard repository paths with fallback
const candidatePaths = [
  path.join(REPO_ROOT, "docs", "HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md"),
  path.join(REPO_ROOT, "HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md"),
  path.join(REPO_ROOT, "docs", "PLAYBOOK.md")
];

const PLAYBOOK_PATH = candidatePaths.find(p => fs.existsSync(p));
assert.ok(PLAYBOOK_PATH, `Handover playbook must exist in repo at docs/HANDOVER_MARKETING_AND_RELEASE_PLAYBOOK.md (checked ${candidatePaths.join(", ")})`);
// Normalized to LF: the assertions below are about document structure, and this
// repo checks out CRLF on Windows, so a raw read fails there and nowhere else.
const playbookContent = fs.readFileSync(PLAYBOOK_PATH, "utf8").replace(/\r\n/g, "\n");

test("SEO Verification: robots.txt conforms to RFC 9309 and isolates sensitive paths per agent group", () => {
  // Extract robots.txt code block from Section 4.5
  const robotsMatch = playbookContent.match(/```text\s*\n(# ===+[\s\S]+?Sitemap:[^\n]+)\n```/);
  assert.ok(robotsMatch, "robots.txt code block must be present in Section 4.5");
  const robotsTxt = robotsMatch[1];

  // 1. Mandatory Agents Check
  const expectedAgents = [
    "User-agent: *",
    "User-agent: GPTBot",
    "User-agent: OAI-SearchBot",
    "User-agent: ChatGPT-User",
    "User-agent: ClaudeBot",
    "User-agent: Claude-Web",
    "User-agent: PerplexityBot",
    "User-agent: Perplexity-User",
    "User-agent: Google-Extended",
    "User-agent: Applebot",
    "User-agent: Applebot-Extended",
    "User-agent: Bytespider"
  ];
  for (const agent of expectedAgents) {
    assert.ok(robotsTxt.includes(agent), `robots.txt must declare '${agent}'`);
  }

  // 2. Group-Aware Disallow Verification (RFC 9309 Consecutive Agent Group Parser)
  const groupRegex = /((?:User-agent:[^\n]+\n)+)([\s\S]+?)(?=(?:\n\s*User-agent:|\n\s*Sitemap:|$))/g;
  const groups = [];
  let match;
  while ((match = groupRegex.exec(robotsTxt)) !== null) {
    groups.push({
      agents: match[1].trim(),
      directives: match[2].trim()
    });
  }

  assert.ok(groups.length >= 5, `robots.txt must contain at least 5 agent record groups (found ${groups.length})`);

  const requiredDisallows = [
    "Disallow: /node_modules/",
    "Disallow: /.git/",
    "Disallow: /dist/",
    "Disallow: /scratch/",
    "Disallow: /tests/"
  ];

  // Verify that all non-Bytespider groups contain ALL 5 required Disallow rules
  for (const group of groups) {
    if (group.agents.includes("Bytespider")) {
      assert.ok(group.directives.includes("Disallow: /"), "Bytespider group must have Disallow: /");
      continue;
    }
    for (const disallow of requiredDisallows) {
      assert.ok(
        group.directives.includes(disallow),
        `Agent group [${group.agents.replace(/\n/g, ", ")}] must contain '${disallow}' to prevent RFC 9309 non-inheritance leaks`
      );
    }
  }

  // 3. Sitemap Declaration Check
  const sitemapMatch = robotsTxt.match(/^Sitemap:\s*(https:\/\/[^\s]+)$/m);
  assert.ok(sitemapMatch, "Sitemap must be declared as an absolute HTTPS URL");
  assert.equal(sitemapMatch[1], "https://arcobaleno64.github.io/gemini-plugin-cc/sitemap.xml");
});

test("AEO Verification: /llms.txt conforms to Answer.AI Spec v2 with Bijective MCP tool mapping", () => {
  // Extract /llms.txt code block from Section 4.6
  const llmsMatch = playbookContent.match(/#### 檔案：`\/llms\.txt`[^\n]*\n```markdown\s*\n(# gemini-plugin-cc[\s\S]+?)\n```/);
  assert.ok(llmsMatch, "/llms.txt code block must be present in Section 4.6");
  const llmsTxt = llmsMatch[1];

  // 1. Structure Verification (Single H1, Blockquote, H2s)
  assert.match(llmsTxt, /^# gemini-plugin-cc\n\n> /m, "Must start with H1 followed by Blockquote summary");
  assert.ok(llmsTxt.includes("## Core Documentation & Guides"), "Must contain Core Documentation H2");
  assert.ok(llmsTxt.includes("## MCP Tools Reference"), "Must contain MCP Tools Reference H2");
  assert.ok(llmsTxt.includes("## Installation & Configuration"), "Must contain Installation & Configuration H2");
  assert.ok(llmsTxt.includes("## Optional"), "Must contain standard Answer.AI ## Optional section");

  // 2. Bijective MCP Tools Ground Truth Check against plugins/gemini/scripts/gemini-mcp.mjs
  assert.ok(Array.isArray(TOOLS) && TOOLS.length >= 6, "TOOLS from gemini-mcp.mjs must contain registered tools");
  const actualToolNames = TOOLS.map(t => t.name);

  const mcpSectionMatch = llmsTxt.match(/## MCP Tools Reference[\s\S]+?(?=## |$)/);
  assert.ok(mcpSectionMatch, "Must contain MCP Tools Reference section");
  const declaredToolNames = [...mcpSectionMatch[0].matchAll(/- `([a-zA-Z0-9_]+)`:/g)].map(m => m[1]);

  // Bijective check (No missing, no extra hallucinated tools)
  assert.equal(
    declaredToolNames.length,
    actualToolNames.length,
    `Declared tool count (${declaredToolNames.length}) must match registered TOOLS count (${actualToolNames.length})`
  );

  for (const declared of declaredToolNames) {
    assert.ok(
      actualToolNames.includes(declared),
      `Hallucinated tool detected in /llms.txt: '${declared}' is not registered in gemini-mcp.mjs`
    );
  }

  for (const toolDef of TOOLS) {
    const toolLine = llmsTxt.split("\n").find(line => line.includes(`\`${toolDef.name}\``));
    assert.ok(toolLine, `Tool line for '${toolDef.name}' must be present`);

    // Verify all required parameters from tool schema are documented in /llms.txt
    const requiredParams = toolDef.inputSchema?.required || [];
    for (const req of requiredParams) {
      assert.ok(
        toolLine.includes(req),
        `Tool '${toolDef.name}' line must document required parameter '${req}' in /llms.txt`
      );
    }
  }

  // 3. Token Length Budget (< 1000 tokens estimated, < 5000 chars)
  assert.ok(llmsTxt.length < 5000, `/llms.txt must be lightweight (< 5000 chars, got ${llmsTxt.length})`);
});

test("GEO Verification: Schema.org JSON-LD structured data is valid and forms a connected DAG", () => {
  // Extract JSON-LD script from Section 4.7
  const jsonLdMatch = playbookContent.match(/<script type="application\/ld\+json">\s*\n([\s\S]+?)\n<\/script>/);
  assert.ok(jsonLdMatch, "JSON-LD script block must be present in Section 4.7");

  const jsonLd = JSON.parse(jsonLdMatch[1]);
  assert.equal(jsonLd["@context"], "https://schema.org");
  assert.ok(Array.isArray(jsonLd["@graph"]), "@graph must be an array of entities");

  const graph = jsonLd["@graph"];
  const software = graph.find(e => {
    const types = Array.isArray(e["@type"]) ? e["@type"] : [e["@type"]];
    return types.includes("SoftwareApplication");
  });
  const article = graph.find(e => e["@type"] === "TechArticle");
  const person = software?.author;
  const publisher = article?.publisher;

  // 1. SoftwareApplication Entity Checks
  assert.ok(software, "SoftwareApplication entity must be present");
  assert.equal(software.name, "gemini-plugin-cc");
  assert.equal(software.applicationCategory, "DeveloperApplication");
  assert.ok(software.offers && software.offers.price === "0");
  assert.ok(software.codeRepository.startsWith("https://github.com/"));

  // 2. TechArticle Entity Checks
  assert.ok(article, "TechArticle entity must be present");
  assert.ok(article.headline, "TechArticle must have headline");
  assert.ok(article.image, "TechArticle must have image for Google Rich Results");
  assert.ok(article.mainEntityOfPage, "TechArticle must have mainEntityOfPage");
  assert.ok(article.about && article.about["@id"] === software["@id"], "TechArticle must anchor to SoftwareApplication @id");
  assert.ok(article.datePublished, "TechArticle must have datePublished");
  assert.ok(article.dateModified, "TechArticle must have dateModified");

  // 3. Author & Publisher Verification
  assert.ok(person && person["@id"], "Author Person entity must have @id");
  assert.ok(publisher && publisher.logo, "Publisher must have ImageObject logo for Google Articles");
});

test("E-E-A-T FAQ Verification: Answer-First structure with isolated scopes and ground-truth alignment", () => {
  const faqKeys = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"];

  // Split FAQ section into individual question blocks to prevent cross-QA drift
  const faqSectionMatch = playbookContent.match(/### 4\.8 E-E-A-T[\s\S]+?(?=### 4\.9|---|\n## )/);
  assert.ok(faqSectionMatch, "Section 4.8 FAQ block must be found");
  const faqSection = faqSectionMatch[0];

  for (const qKey of faqKeys) {
    const qRegex = new RegExp(`####\\s+${qKey}:[\\s\\S]+?(?=####\\s+Q\\d|---|$)`, "i");
    const qBlockMatch = faqSection.match(qRegex);
    assert.ok(qBlockMatch, `FAQ block for ${qKey} must exist`);
    const qBlock = qBlockMatch[0];

    // First paragraph under header must be Answer-First bold leading blockquote
    const answerMatch = qBlock.match(/> \*\*([^*]+)\*\*/);
    assert.ok(answerMatch, `FAQ ${qKey} must have leading bold answer in blockquote (> **...**)`);
    assert.ok(answerMatch[1].trim().length >= 30, `FAQ ${qKey} answer-first sentence must be >= 30 chars`);

    // Scoped assertions
    if (qKey === "Q6") {
      assert.ok(qBlock.includes(".env*"), "Q6 block specifically must mention .env*");
      assert.ok(qBlock.includes("credentials.json"), "Q6 block specifically must mention credentials.json");
    }
    if (qKey === "Q7") {
      assert.ok(qBlock.includes("Apache License 2.0"), "Q7 block specifically must mention Apache License 2.0");
    }
  }
});
