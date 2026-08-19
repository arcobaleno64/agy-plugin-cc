const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const ROOT = "/srv/uploads";

function readUpload(name) {
  const target = path.join(ROOT, name);
  return fs.readFileSync(target, "utf8");
}

function archive(name) {
  execSync(`tar -czf ${name}.tar.gz ${path.join(ROOT, name)}`);
}

function pickPage(body, pages) {
  const page = parseInt(body.page);
  return pages[page];
}

module.exports = { readUpload, archive, pickPage };
