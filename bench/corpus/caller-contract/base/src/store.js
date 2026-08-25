const rows = [
  { id: "u1", name: "Ada", role: "admin" },
  { id: "u2", name: "Grace", role: "member" }
];

// Returns the user record, or null when there is no such id.
function findUser(id) {
  return rows.find((row) => row.id === id) || null;
}

module.exports = { findUser };
