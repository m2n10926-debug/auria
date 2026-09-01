"use strict";

const { getGb } = require("./groupboard");

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "ログインが必要です。" });
  }
  return res.redirect("/login.html?next=" + encodeURIComponent(req.originalUrl));
}

// GROUP BOARDで宣言した"admin"権限を持つ人だけを通す。requireAuthの後段で使う。
async function requireAdmin(req, res, next) {
  const empId = req.session && req.session.user && req.session.user.empId;
  try {
    const gb = await getGb();
    if (empId && (await gb.permissions.can(empId, "admin"))) return next();
  } catch (err) {
    return res.status(500).json({ error: "権限の確認に失敗しました。" });
  }
  return res.status(403).json({ error: "この操作を行う権限がありません。" });
}

module.exports = { requireAuth, requireAdmin };
