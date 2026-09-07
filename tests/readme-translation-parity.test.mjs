import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AGY_MINIMUM_VERSION } from "../plugins/gemini/scripts/lib/engine.mjs";

// The two READMEs describe one product, and the way they come apart is not that
// someone forgets the translation exists — it is that a change edits one line of
// it and leaves the rest, so the file looks updated. That happened at the AGY
// version floor: the Chinese README's opening line said 1.1.12 while its own
// prerequisites table two screens below still said 1.0.3.
//
// Version numbers are the part of a document that survives translation
// unchanged, which is what makes the drift mechanically visible.

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (name) => fs.readFileSync(path.join(ROOT, name), "utf8");

const READMES = ["README.md", "README.zh-TW.md"];

// Bare `x.y.z` with no word character or dot on either side, so `v1.0.6` in a
// release link and `18` in a Node requirement stay out.
const versionsIn = (text) =>
  new Set([...text.matchAll(/(?<![\w.])\d+\.\d+\.\d+(?![\w.])/g)].map((m) => m[0]));

test("both READMEs cite the same set of version numbers", () => {
  const [en, zh] = READMES.map((name) => versionsIn(read(name)));
  const enOnly = [...en].filter((v) => !zh.has(v)).sort();
  const zhOnly = [...zh].filter((v) => !en.has(v)).sort();
  assert.deepEqual(
    { enOnly, zhOnly },
    { enOnly: [], zhOnly: [] },
    "a version claim was changed in one README and not the other"
  );
});

test("both READMEs' AGY prerequisite names the floor the code enforces", () => {
  for (const name of READMES) {
    const row = read(name)
      .split(/\r?\n/)
      .find((line) => /^\|\s*AGY\s*\|/.test(line));
    assert.ok(row, `${name} has no AGY row in its prerequisites table`);
    // The first version in the row is the one being required; later ones are
    // what it was verified on and what the refusal explains. Asserting the
    // floor appears anywhere in the row would pass on a row that requires
    // something older and merely mentions the floor further along.
    const [stated] = [...versionsIn(row)];
    assert.equal(
      stated,
      AGY_MINIMUM_VERSION,
      `${name} requires AGY ${stated}, but the code enforces ${AGY_MINIMUM_VERSION}: ${row}`
    );
  }
});
