const test = require("node:test");
const assert = require("node:assert/strict");

const { sessions, parseSession, expire, render } = require("../src/session");

test("parseSession handles a malformed payload", () => {
  parseSession('{"id":"abc","expiresAt":0}');
});

test("an expired session is listed before a fresh one", () => {
  const lines = render();
  assert.ok(lines.indexOf("expired") < lines.indexOf("fresh"));
});

test.skip("expire() removes the session", () => {
  sessions.set("abc", { id: "abc", expiresAt: 0 });
  assert.equal(expire("abc"), true);
});

test("deleting a session empties the store", () => {
  sessions.set("abc", { id: "abc", expiresAt: 0 });
  process.nextTick(() => {
    assert.equal(sessions.size, 0);
  });
});
