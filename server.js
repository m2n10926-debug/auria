#!/usr/bin/env node
"use strict";

const path = require("path");
const express = require("express");
const session = require("express-session");
const FileStoreFactory = require("session-file-store");
const core = require("./lib/core");
const accounts = require("./lib/accounts");
const { requireAuth } = require("./lib/auth");

core.loadDotEnvIfPresent();

const FileStore = FileStoreFactory(session);

const app = express();
app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));

app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    store: new FileStore({
      path: process.env.SESSION_STORE_DIR || path.join(__dirname, "sessions"),
      retries: 1,
      logFn: () => {}, // 静かに（デフォルトはconsole.error）
    }),
    secret: process.env.SESSION_SECRET || "change-me-in-.env",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000),
    },
  })
);

// --- 認証ルート（未認証でもアクセス可） ---
app.post("/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "ユーザー名とパスワードを入力してください。" });
  }
  const user = accounts.verifyPassword(username, password);
  if (!user) {
    return res.status(401).json({ error: "ユーザー名またはパスワードが正しくありません。" });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "ログインに失敗しました。" });
    req.session.user = user;
    res.json({ ok: true, user });
  });
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

app.use(express.static(path.join(__dirname, "public-auth")));

// --- ここから下は認証必須 ---
app.use(requireAuth);

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user });
});

app.post("/api/generate", async (req, res) => {
  const accountId = req.session.user.accountId;
  const { memo, name, model, height, weight, bust, type, age, occupation, impression } = req.body || {};
  try {
    const result = await core.generateIntro({
      memo,
      name,
      model,
      height,
      weight,
      bust,
      type,
      age,
      occupation,
      impression,
      accountId,
    });
    const record = core.saveHistory({
      name,
      memo,
      output: result.output,
      recommendation: result.recommendation,
      model: result.model,
      bannedHits: result.bannedHits,
      missingHeadings: result.missingHeadings,
      closingRepetition: result.closingRepetition,
      missingRecommendation: result.missingRecommendation,
      consistencyWarnings: result.consistencyWarnings,
      height,
      weight,
      bust,
      type,
      age,
      occupation,
      impression,
      accountId,
    });
    res.json({ ...result, id: record.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/history", (req, res) => {
  res.json(core.listHistory(req.session.user.accountId));
});

app.get("/api/history/:id", (req, res) => {
  const record = core.getHistory(req.params.id, req.session.user.accountId);
  if (!record) {
    res.status(404).json({ error: "履歴が見つかりません。" });
    return;
  }
  res.json(record);
});

app.get("/api/banned-words", (req, res) => {
  res.json({ raw: core.readBannedWordsRaw(req.session.user.accountId) });
});

app.put("/api/banned-words", (req, res) => {
  const { raw } = req.body || {};
  if (typeof raw !== "string") {
    res.status(400).json({ error: "raw (文字列) が必要です。" });
    return;
  }
  core.writeBannedWordsRaw(raw, req.session.user.accountId);
  res.json({ ok: true });
});

app.get("/api/style-notes", (req, res) => {
  res.json({ raw: core.readStyleNotesRaw(req.session.user.accountId) });
});

app.put("/api/style-notes", (req, res) => {
  const { raw } = req.body || {};
  if (typeof raw !== "string") {
    res.status(400).json({ error: "raw (文字列) が必要です。" });
    return;
  }
  core.writeStyleNotesRaw(raw, req.session.user.accountId);
  res.json({ ok: true });
});

// --- 個人サンプル（自分の紹介文サンプル） ---
app.get("/api/examples/personal", (req, res) => {
  res.json(accounts.listPersonalExamples(req.session.user.accountId));
});

app.post("/api/examples/personal", (req, res) => {
  const { title, content } = req.body || {};
  try {
    const record = accounts.addPersonalExample(req.session.user.accountId, { title, content });
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/examples/personal/:id", (req, res) => {
  accounts.deletePersonalExample(req.session.user.accountId, req.params.id);
  res.json({ ok: true });
});

// --- パスワード変更 ---
app.post("/api/change-password", (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    accounts.changePassword(req.session.user.accountId, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/change-display-name", (req, res) => {
  const { displayName } = req.body || {};
  try {
    const updated = accounts.updateDisplayName(req.session.user.accountId, displayName);
    req.session.user.displayName = updated.displayName;
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`intro-writer web app: http://localhost:${PORT}`);
});
