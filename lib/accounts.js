"use strict";

/**
 * アカウントごとのデータ分離（ログイン機能用）
 * ユーザー名+パスワードのアカウント。認証情報・履歴・禁止ワード・文章の癖・個人サンプルは
 * すべてPostgres（lib/db.js）に保存する（Vercelのサーバーレス環境は永続ローカルディスクを持たないため）。
 *
 * CLI（generate.js）はこのファイルを経由せず、常に lib/core.js のルート直下ファイル
 * （accountId未指定時のフォールバック経路）を使うため無変更のまま動作する。
 */

const crypto = require("crypto");
const core = require("./core");
const db = require("./db");

// メールアドレスをユーザー名として使えるよう、英数字に加えて . _ % + - @ を許可する。
// "/" "\" は明示的に許可しない。
const USERNAME_PATTERN = /^[a-zA-Z0-9._%+-]+@?[a-zA-Z0-9._%+-]*$/;

// DBの主キー(account_id)にそのまま使うため、明らかに不正な値は早期に弾く（多層防御）。
function assertSafeId(id) {
  const safe = String(id || "").trim();
  if (!safe || safe === "." || safe === "..") {
    throw new Error("不正なIDです。");
  }
  return safe;
}

// ユーザー名は生の入力を直接パターン検証する。
function assertValidUsername(username) {
  const raw = String(username || "").trim();
  if (!USERNAME_PATTERN.test(raw)) {
    throw new Error(
      "ユーザー名に使用できない文字が含まれています。使用できるのは半角英数字と . _ % + - @ のみです。"
    );
  }
  if (raw === "." || raw === "..") {
    throw new Error("不正なユーザー名です。");
  }
  return raw;
}

// accountId未指定（CLI）の場合のみ意味を持つ、ルート直下ファイルへのフォールバックパス。
function resolvePaths() {
  return {
    personalExamplesDir: null,
    bannedWordsPath: core.BANNED_WORDS_PATH,
    styleNotesPath: core.STYLE_NOTES_PATH,
    historyDir: core.HISTORY_DIR,
  };
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPasswordHash(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

async function accountExists(accountId) {
  const { rows } = await db.query("SELECT 1 FROM accounts WHERE account_id = $1", [accountId]);
  return rows.length > 0;
}

async function createAccount({ username, displayName, password }) {
  const accountId = assertValidUsername(username);
  if (!password || password.length < 8) {
    throw new Error("パスワードは8文字以上にしてください。");
  }
  if (await accountExists(accountId)) {
    throw new Error(`アカウント "${accountId}" は既に存在します。`);
  }

  // 新規アカウント作成時点のルート直下ファイル（CLI用デフォルト）をシードする。
  // core.readBannedWordsRaw()/readStyleNotesRaw() は引数なしで呼ぶと常に同期・ファイルベースの
  // ままなので、ここではDBを介さずそのまま使える。
  const bannedSeed = core.readBannedWordsRaw();
  const styleSeed = core.readStyleNotesRaw();

  const { salt, hash } = hashPassword(password);
  const finalDisplayName = displayName || accountId;
  await db.query(
    `INSERT INTO accounts (account_id, display_name, password_salt, password_hash, banned_words_raw, style_notes_raw)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [accountId, finalDisplayName, salt, hash, bannedSeed, styleSeed]
  );
  return { accountId, displayName: finalDisplayName };
}

async function verifyPassword(username, password) {
  let accountId;
  try {
    accountId = assertValidUsername(username);
  } catch {
    return null;
  }
  const { rows } = await db.query(
    "SELECT account_id, display_name, password_salt, password_hash FROM accounts WHERE account_id = $1",
    [accountId]
  );
  const row = rows[0];
  if (!row) return null;
  if (!verifyPasswordHash(password, row.password_salt, row.password_hash)) return null;

  await db.query("UPDATE accounts SET last_login_at = now() WHERE account_id = $1", [accountId]);
  return { accountId: row.account_id, displayName: row.display_name };
}

async function changePassword(accountId, currentPassword, newPassword) {
  const { rows } = await db.query(
    "SELECT password_salt, password_hash FROM accounts WHERE account_id = $1",
    [accountId]
  );
  const row = rows[0];
  if (!row) throw new Error("アカウントが見つかりません。");
  if (!verifyPasswordHash(currentPassword, row.password_salt, row.password_hash)) {
    throw new Error("現在のパスワードが正しくありません。");
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error("新しいパスワードは8文字以上にしてください。");
  }
  const { salt, hash } = hashPassword(newPassword);
  await db.query("UPDATE accounts SET password_salt = $1, password_hash = $2 WHERE account_id = $3", [
    salt,
    hash,
    accountId,
  ]);
}

async function updateDisplayName(accountId, displayName) {
  const trimmed = String(displayName || "").trim();
  if (!trimmed) throw new Error("表示名を入力してください。");
  const { rowCount } = await db.query("UPDATE accounts SET display_name = $1 WHERE account_id = $2", [
    trimmed,
    accountId,
  ]);
  if (!rowCount) throw new Error("アカウントが見つかりません。");
  return { accountId, displayName: trimmed };
}

// --- 禁止ワード・文章の癖（アカウントごと） ---

async function getBannedWordsRaw(accountId) {
  const { rows } = await db.query("SELECT banned_words_raw FROM accounts WHERE account_id = $1", [
    accountId,
  ]);
  return rows[0] ? rows[0].banned_words_raw : "";
}

async function setBannedWordsRaw(accountId, text) {
  await db.query("UPDATE accounts SET banned_words_raw = $1 WHERE account_id = $2", [text, accountId]);
}

async function getStyleNotesRaw(accountId) {
  const { rows } = await db.query("SELECT style_notes_raw FROM accounts WHERE account_id = $1", [
    accountId,
  ]);
  return rows[0] ? rows[0].style_notes_raw : "";
}

async function setStyleNotesRaw(accountId, text) {
  await db.query("UPDATE accounts SET style_notes_raw = $1 WHERE account_id = $2", [text, accountId]);
}

// --- 見出し構成のカスタマイズ（アカウントごと） ---
// 空文字列 = 未カスタマイズ（core.js側の既定の6見出し構成をそのまま使う）。

async function getHeadingStructureRaw(accountId) {
  const { rows } = await db.query(
    "SELECT heading_structure_raw FROM accounts WHERE account_id = $1",
    [accountId]
  );
  return rows[0] ? rows[0].heading_structure_raw : "";
}

async function setHeadingStructureRaw(accountId, text) {
  await db.query("UPDATE accounts SET heading_structure_raw = $1 WHERE account_id = $2", [
    text,
    accountId,
  ]);
}

// --- 個人サンプル CRUD ---

async function listPersonalExamples(accountId) {
  const { rows } = await db.query(
    "SELECT id, title, content, created_at FROM personal_examples WHERE account_id = $1 ORDER BY created_at DESC",
    [accountId]
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    preview: (r.content || "").slice(0, 60),
    createdAt: r.created_at,
  }));
}

async function getPersonalExample(accountId, id) {
  const safeId = assertSafeId(id);
  const { rows } = await db.query(
    "SELECT id, title, content, created_at FROM personal_examples WHERE account_id = $1 AND id = $2",
    [accountId, safeId]
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, title: r.title, content: r.content, createdAt: r.created_at };
}

async function addPersonalExample(accountId, { title, content }) {
  if (!content || !content.trim()) throw new Error("本文が空です。");
  const { rows } = await db.query(
    `INSERT INTO personal_examples (account_id, title, content)
     VALUES ($1, $2, $3)
     RETURNING id, title, content, created_at`,
    [accountId, title || "", content.trim()]
  );
  const r = rows[0];
  return { id: r.id, title: r.title, content: r.content, createdAt: r.created_at };
}

async function deletePersonalExample(accountId, id) {
  const safeId = assertSafeId(id);
  await db.query("DELETE FROM personal_examples WHERE account_id = $1 AND id = $2", [accountId, safeId]);
}

async function loadPersonalExamplesText(accountId) {
  const { rows } = await db.query(
    "SELECT content FROM personal_examples WHERE account_id = $1 ORDER BY created_at ASC",
    [accountId]
  );
  return rows
    .map((r) => r.content || "")
    .filter(Boolean)
    .join("\n\n---\n\n");
}

// --- 履歴（アカウントごと） ---

async function saveHistory(accountId, record) {
  const {
    name,
    memo,
    output,
    recommendation,
    model,
    bannedHits,
    missingHeadings,
    closingRepetition,
    missingRecommendation,
    consistencyWarnings,
    height,
    weight,
    bust,
    type,
    age,
    occupation,
    impression,
  } = record;

  const { rows } = await db.query(
    `INSERT INTO history (
       account_id, name, memo, output, recommendation, model,
       banned_hits, missing_headings, closing_repetition, missing_recommendation, consistency_warnings,
       height, weight, bust, type, age, occupation, impression
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id, created_at`,
    [
      accountId,
      name,
      memo,
      output,
      recommendation || "",
      model,
      bannedHits || [],
      missingHeadings || [],
      !!closingRepetition,
      !!missingRecommendation,
      consistencyWarnings || [],
      height || null,
      weight || null,
      bust || null,
      type || null,
      age || null,
      occupation || null,
      impression || null,
    ]
  );
  return { id: rows[0].id, createdAt: rows[0].created_at, ...record };
}

async function listHistory(accountId) {
  const { rows } = await db.query(
    "SELECT id, name, output, created_at FROM history WHERE account_id = $1 ORDER BY created_at DESC",
    [accountId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    preview: (r.output || "").slice(0, 60),
  }));
}

async function getHistory(accountId, id) {
  const safeId = assertSafeId(id);
  const { rows } = await db.query("SELECT * FROM history WHERE account_id = $1 AND id = $2", [
    accountId,
    safeId,
  ]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    memo: r.memo,
    output: r.output,
    recommendation: r.recommendation,
    model: r.model,
    createdAt: r.created_at,
    bannedHits: r.banned_hits,
    missingHeadings: r.missing_headings,
    closingRepetition: r.closing_repetition,
    missingRecommendation: r.missing_recommendation,
    consistencyWarnings: r.consistency_warnings,
    height: r.height,
    weight: r.weight,
    bust: r.bust,
    type: r.type,
    age: r.age,
    occupation: r.occupation,
    impression: r.impression,
  };
}

module.exports = {
  assertSafeId,
  assertValidUsername,
  resolvePaths,
  accountExists,
  createAccount,
  verifyPassword,
  changePassword,
  updateDisplayName,
  getBannedWordsRaw,
  setBannedWordsRaw,
  getStyleNotesRaw,
  setStyleNotesRaw,
  getHeadingStructureRaw,
  setHeadingStructureRaw,
  listPersonalExamples,
  getPersonalExample,
  addPersonalExample,
  deletePersonalExample,
  loadPersonalExamplesText,
  saveHistory,
  listHistory,
  getHistory,
};
