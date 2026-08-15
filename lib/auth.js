"use strict";

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "ログインが必要です。" });
  }
  return res.redirect("/login.html");
}

module.exports = { requireAuth };
