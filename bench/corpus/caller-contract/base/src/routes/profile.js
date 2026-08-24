const { findUser } = require("../store");

function profileRoute(req, res) {
  const user = findUser(req.params.id);
  if (!user) {
    return res.status(404).json({ error: "not found" });
  }
  return res.json({ id: user.id, name: user.name });
}

module.exports = { profileRoute };
