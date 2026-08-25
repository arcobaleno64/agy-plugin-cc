const rows = [
  { id: "u1", name: "Ada", role: "admin" },
  { id: "u2", name: "Grace", role: "member" }
];

// Returns a result envelope so callers can tell "absent" from "lookup failed".
function findUser(id) {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    return { ok: false, reason: "not-found" };
  }
  return { ok: true, user: row };
}

module.exports = { findUser };
