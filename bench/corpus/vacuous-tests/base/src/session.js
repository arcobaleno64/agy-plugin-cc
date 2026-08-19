const sessions = new Map();

function parseSession(raw) {
  const parsed = JSON.parse(raw);
  return { id: parsed.id, expiresAt: parsed.expiresAt };
}

function expire(id) {
  return sessions.delete(id);
}

function render() {
  return [...sessions.values()].map((s) => (s.expiresAt < Date.now() ? "expired" : "fresh"));
}

module.exports = { sessions, parseSession, expire, render };
