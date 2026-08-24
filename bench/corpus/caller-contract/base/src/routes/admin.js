const { findUser } = require("../store");

function requireAdmin(req, res, next) {
  const user = findUser(req.params.id);
  if (user && user.role === "admin") {
    return next();
  }
  return res.status(403).json({ error: "forbidden" });
}

module.exports = { requireAdmin };
