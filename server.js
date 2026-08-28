#!/usr/bin/env node
"use strict";

const path = require("path");
const express = require("express");
const cookieSession = require("cookie-session");
const core = require("./lib/core");
const accounts = require("./lib/accounts");
const { requireAuth } = require("./lib/auth");

core.loadDotEnvIfPresent();

const app = express();
app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));

app.use(express.json({ limit: "1mb" }));

app.use(
  cookieSession({
    name: "session",
    keys: [process.env.SESSION_SECRET || "change-me-in-.env"],
    maxAge: Number(process.env.SESSION_MAX_AGE_MS || 7 * 24 * 60 * 60 * 1000),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
  })
);

// --- 認証ルート（未認証でもアクセス可） ---
app.post("/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "ユーザー名とパスワードを入力してください。" });
  }
  try {
    const user = await accounts.verifyPassword(username, password);
    if (!user) {
      return res.status(401).json({ error: "ユーザー名またはパスワードが正しくありません。" });
    }
    // セッションを丸ごと置き換える（未認証時のCookieがログイン後に「昇格」されるのを防ぐ）
    req.session = { user };
    res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ error: "ログインに失敗しました。" });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "public-auth")));

// --- ここから下は認証必須 ---
app.use(requireAuth);

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user });
});

app.post("/api/clean-memo", async (req, res) => {
  const { memo } = req.body || {};
  if (!memo || !memo.trim()) {
    res.status(400).json({ error: "面接メモを入力してください。" });
    return;
  }
  try {
    const result = await core.cleanUpMemo(memo.trim());
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/generate", async (req, res) => {
  const accountId = req.session.user.accountId;
  const { memo, name, model, height, weight, bust, type, age, occupation, impression, includeConcerns } =
    req.body || {};
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
      includeConcerns: !!includeConcerns,
      accountId,
    });
    const record = await core.saveHistory({
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

app.get("/api/history", async (req, res) => {
  try {
    res.json(await core.listHistory(req.session.user.accountId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/history/:id", async (req, res) => {
  try {
    const record = await core.getHistory(req.params.id, req.session.user.accountId);
    if (!record) {
      res.status(404).json({ error: "履歴が見つかりません。" });
      return;
    }
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 生成結果の利用状況計測（コピー・編集の有無。アプリ画面には表示しない）
app.post("/api/history/:id/copied", async (req, res) => {
  try {
    await accounts.markHistoryCopied(req.session.user.accountId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/history/:id/edited", async (req, res) => {
  try {
    await accounts.markHistoryEdited(req.session.user.accountId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/banned-words", async (req, res) => {
  try {
    const raw = await core.readBannedWordsRaw(req.session.user.accountId);
    const globalWords = core.loadGlobalBannedWords();
    const personalWords = core.parseBannedWordsText(raw).filter((w) => !globalWords.includes(w));
    res.json({ globalWords, personalWords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/banned-words", async (req, res) => {
  const { personalWords } = req.body || {};
  if (!Array.isArray(personalWords) || !personalWords.every((w) => typeof w === "string")) {
    res.status(400).json({ error: "personalWords (文字列の配列) が必要です。" });
    return;
  }
  try {
    await core.writeBannedWordsRaw(personalWords.join("\n"), req.session.user.accountId);
    res.json({ ok: true, personalWords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/style-notes", async (req, res) => {
  try {
    const raw = await core.readStyleNotesRaw(req.session.user.accountId);
    res.json({ items: core.parseStyleNoteItems(raw) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/style-notes", async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || !items.every((item) => typeof item === "string")) {
    res.status(400).json({ error: "items (文字列の配列) が必要です。" });
    return;
  }
  try {
    const raw = core.buildStyleNotesRawFromItems(items);
    await core.writeStyleNotesRaw(raw, req.session.user.accountId);
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/style-notes/chat", async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) {
    res.status(400).json({ error: "message が必要です。" });
    return;
  }
  try {
    const accountId = req.session.user.accountId;
    const currentRaw = await core.readStyleNotesRaw(accountId);
    const currentItems = core.parseStyleNoteItems(currentRaw);
    const newItems = await core.chatUpdateStyleNotes(currentItems, message.trim());
    if (newItems.length === 0 && currentItems.length > 0) {
      res.status(400).json({ error: "指示の内容をうまく理解できませんでした。もう少し具体的に書いてみてください。" });
      return;
    }
    const changed = JSON.stringify(newItems) !== JSON.stringify(currentItems);
    if (!changed) {
      res
        .status(400)
        .json({ error: "指示の内容を認識できませんでした。もう少し具体的に書いてみてください。" });
      return;
    }
    const newRaw = core.buildStyleNotesRawFromItems(newItems);
    await core.writeStyleNotesRaw(newRaw, accountId);
    res.json({ ok: true, items: newItems });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 見出し構成のカスタマイズ ---
app.get("/api/heading-structure", async (req, res) => {
  try {
    const raw = await accounts.getHeadingStructureRaw(req.session.user.accountId);
    const structure = core.parseHeadingStructureRaw(raw);
    res.json({ headings: structure || core.getDefaultHeadingStructure(), isCustomized: !!structure });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/heading-structure", async (req, res) => {
  const { headings } = req.body || {};
  try {
    if (!Array.isArray(headings) || headings.length === 0) {
      await accounts.setHeadingStructureRaw(req.session.user.accountId, "");
      res.json({ ok: true, headings: core.getDefaultHeadingStructure(), isCustomized: false });
      return;
    }
    const normalized = core.normalizeHeadingStructureInput(headings);
    await accounts.setHeadingStructureRaw(req.session.user.accountId, JSON.stringify(normalized));
    res.json({ ok: true, headings: normalized, isCustomized: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- 個人サンプル（自分の紹介文サンプル） ---
app.get("/api/examples/personal", async (req, res) => {
  try {
    res.json(await accounts.listPersonalExamples(req.session.user.accountId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/examples/personal", async (req, res) => {
  const { title, content } = req.body || {};
  try {
    const record = await accounts.addPersonalExample(req.session.user.accountId, { title, content });
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/api/examples/personal/:id", async (req, res) => {
  try {
    await accounts.deletePersonalExample(req.session.user.accountId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- パスワード変更 ---
app.post("/api/change-password", async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  try {
    await accounts.changePassword(req.session.user.accountId, currentPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/change-display-name", async (req, res) => {
  const { displayName } = req.body || {};
  try {
    const updated = await accounts.updateDisplayName(req.session.user.accountId, displayName);
    req.session.user.displayName = updated.displayName;
    res.json({ ok: true, user: req.session.user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- アカウント発行（管理者のみ） ---
app.get("/api/admin/accounts", async (req, res) => {
  if (!req.session.user.isAdmin) {
    return res.status(403).json({ error: "この操作を行う権限がありません。" });
  }
  try {
    res.json(await accounts.listAccounts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/admin/accounts", async (req, res) => {
  if (!req.session.user.isAdmin) {
    return res.status(403).json({ error: "この操作を行う権限がありません。" });
  }
  const { username, password, displayName } = req.body || {};
  try {
    const created = await accounts.createAccount({ username, password, displayName });
    res.json({ ok: true, account: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`intro-writer web app: http://localhost:${PORT}`);
  });
}

module.exports = app;
