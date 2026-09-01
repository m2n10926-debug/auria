#!/usr/bin/env node
"use strict";

const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const cookieSession = require("cookie-session");
const core = require("./lib/core");

core.loadDotEnvIfPresent();

const accounts = require("./lib/accounts");
const { requireAuth, requireAdmin } = require("./lib/auth");
const { getGb, getTokens, requestContextMiddleware } = require("./lib/groupboard");

const app = express();
app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(requestContextMiddleware);

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

// ログイン開始: GROUP BOARDの認可画面へリダイレクトする。
app.get("/api/auth/sso", async (req, res) => {
  try {
    const gb = await getGb();
    const auth = await gb.auth();
    const idp = await gb.identityProvider();
    const { url, state, codeVerifier } = await auth.buildAuthorizeUrl({ identityProvider: idp ?? undefined });
    const rawNext = typeof req.query.next === "string" ? req.query.next : "/";
    const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";
    res.cookie("gb_oauth", JSON.stringify({ state, codeVerifier, next }), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      secure: process.env.NODE_ENV === "production",
      maxAge: 10 * 60 * 1000,
    });
    console.log("[auth/sso] NODE_ENV=%s state=%s host=%s", process.env.NODE_ENV, state, req.headers.host);
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`GROUP BOARDへの接続に失敗しました。しばらくしてから再度お試しください。（${err.message}）`);
  }
});

// ログインcallback: codeをトークンに交換し、本人特定・アカウント紐づけを行う。
app.get("/api/auth/callback/groupboard", async (req, res) => {
  const oauthCookie = req.cookies && req.cookies.gb_oauth;
  res.clearCookie("gb_oauth", { path: "/" });

  let saved;
  try {
    saved = JSON.parse(oauthCookie || "null");
  } catch {
    saved = null;
  }
  console.log(
    "[auth/callback] host=%s cookieHeaderPresent=%s cookieKeys=%j hasGbOauth=%s parsedOk=%s queryState=%s savedState=%s",
    req.headers.host,
    !!req.headers.cookie,
    req.cookies ? Object.keys(req.cookies) : null,
    !!oauthCookie,
    !!saved,
    req.query.state,
    saved && saved.state
  );
  if (!saved || !req.query.state || req.query.state !== saved.state) {
    return res.status(400).send("ログイン処理の有効期限が切れました。もう一度ログインしてください。");
  }
  if (!req.query.code) {
    return res.status(400).send("ログインがキャンセルされました。");
  }

  try {
    const gb = await getGb();
    const tokens = await getTokens();
    const auth = await gb.auth();
    const result = await auth.handleCallback({ code: req.query.code, codeVerifier: saved.codeVerifier });

    // fail-closed: empIdが取れない場合はログインさせない。
    if (!result.empId) {
      return res.status(403).send("社員情報を確認できませんでした。管理担当者にご連絡ください。");
    }
    if (!result.email) {
      return res.status(403).send("メールアドレスを確認できませんでした。管理担当者にご連絡ください。");
    }

    await tokens.save(result);
    await accounts.ensureAccountForSso(result.email);
    await accounts.recordLogin(result.email);
    const isAdmin = await gb.permissions.can(result.empId, "admin");

    // セッションを丸ごと置き換える（未認証時のCookieがログイン後に「昇格」されるのを防ぐ）
    req.session = {
      user: { accountId: result.email, empId: result.empId, displayName: result.email, isAdmin },
    };
    res.redirect(saved.next || "/");
  } catch (err) {
    res.status(500).send(`ログインに失敗しました。（${err.message}）`);
  }
});

app.get("/api/auth/logout", async (req, res) => {
  try {
    const gb = await getGb();
    const tokens = await getTokens();
    const auth = await gb.auth();
    const logoutUrl = auth.buildLogoutUrl({
      redirectUri: `${(process.env.GROUPBOARD_APP_URL || "").replace(/\/$/, "")}/login.html`,
    });
    await tokens.clear();
    req.session = null;
    res.redirect(logoutUrl);
  } catch (err) {
    req.session = null;
    res.redirect("/login.html");
  }
});

app.use(express.static(path.join(__dirname, "public-auth")));

// GROUP BOARDのポータルがタイル表示のため未ログインで直接叩くので、認証ゲートより前に置く。
app.get("/favicon.ico", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "favicon.ico"));
});

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
  const { memo, name, model, provider, height, weight, bust, type, age, occupation, impression, includeConcerns } =
    req.body || {};
  try {
    const result = await core.generateIntro({
      memo,
      name,
      model,
      provider,
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

// --- 利用状況（管理者のみ。アカウントの発行自体はGROUP BOARD側のロール割当で行う） ---
app.get("/api/admin/accounts", requireAdmin, async (req, res) => {
  try {
    res.json(await accounts.listAccounts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`intro-writer web app: http://localhost:${PORT}`);
  });
}

module.exports = app;
