"use strict";

/**
 * アカウントごとのデータ分離（ログイン機能用）
 * ユーザー名+パスワードのローカルアカウント。外部サービス（OAuth等）は使わない。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const core = require("./core");

const ACCOUNTS_DIR = path.join(core.ROOT, "accounts");

// メールアドレスをユーザー名として使えるよう、英数字に加えて . _ % + - @ を許可する。
// "/" "\" は明示的に許可しない（パス区切り文字のため、これを許すとディレクトリ構造を操作されうる）。
const USERNAME_PATTERN = /^[a-zA-Z0-9._%+-]+@?[a-zA-Z0-9._%+-]*$/;

function assertSafeId(id) {
  const safe = path.basename(String(id || ""));
  if (!safe || safe === "." || safe === "..") {
    throw new Error("不正なIDです。");
  }
  return safe;
}

// ユーザー名は生の入力を直接パターン検証する（path.basename等での正規化はしない）。
// 例えば "../../etc" を先にbasename化すると黙って "etc" に化けてしまい、
// 意図しないアカウントを操作してしまう恐れがあるため、許可文字以外は即エラーにする。
function assertValidUsername(username) {
  const raw = String(username || "").trim();
  if (!USERNAME_PATTERN.test(raw)) {
    throw new Error(
      "ユーザー名に使用できない文字が含まれています。使用できるのは半角英数字と . _ % + - @ のみです。"
    );
  }
  // "." や ".." だけの値はディレクトリ操作に使われる特殊な意味を持つため明示的に拒否する
  // （accountDir()側のassertSafeIdでも防げるが、入力検証の時点で分かりやすく弾く）。
  if (raw === "." || raw === "..") {
    throw new Error("不正なユーザー名です。");
  }
  return raw;
}

function accountDir(accountId) {
  return path.join(ACCOUNTS_DIR, assertSafeId(accountId));
}

// accountId が未指定なら core.js の既存ルート直下パスにフォールバック（CLI互換の要）
function resolvePaths(accountId) {
  if (!accountId) {
    return {
      personalExamplesDir: null,
      bannedWordsPath: core.BANNED_WORDS_PATH,
      styleNotesPath: core.STYLE_NOTES_PATH,
      historyDir: core.HISTORY_DIR,
    };
  }
  const dir = accountDir(accountId);
  return {
    personalExamplesDir: path.join(dir, "examples"),
    bannedWordsPath: path.join(dir, "banned-words.txt"),
    styleNotesPath: path.join(dir, "style-notes.txt"),
    historyDir: path.join(dir, "history"),
  };
}

function accountExists(accountId) {
  return fs.existsSync(path.join(accountDir(accountId), "meta.json"));
}

function readMeta(accountId) {
  const metaPath = path.join(accountDir(accountId), "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

function writeMeta(accountId, meta) {
  const metaPath = path.join(accountDir(accountId), "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
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

function listAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs
    .readdirSync(ACCOUNTS_DIR)
    .filter((name) => fs.existsSync(path.join(ACCOUNTS_DIR, name, "meta.json")));
}

function createAccount({ username, displayName, password }) {
  const accountId = assertValidUsername(username);
  if (!password || password.length < 8) {
    throw new Error("パスワードは8文字以上にしてください。");
  }
  if (accountExists(accountId)) {
    throw new Error(`アカウント "${accountId}" は既に存在します。`);
  }

  const dir = accountDir(accountId);
  fs.mkdirSync(path.join(dir, "examples"), { recursive: true });
  fs.mkdirSync(path.join(dir, "history"), { recursive: true });

  // 新規アカウント作成時点のルート直下ファイル（未保存の場合はデフォルト値）をシードする
  // core.readBannedWordsRaw()/readStyleNotesRaw() 経由にすることで、ファイルが未作成でも
  // 正しいフォールバック（style-notesはDEFAULT_STYLE_NOTES）が効く
  const bannedSeed = core.readBannedWordsRaw();
  const styleSeed = core.readStyleNotesRaw();
  fs.writeFileSync(path.join(dir, "banned-words.txt"), bannedSeed, "utf8");
  fs.writeFileSync(path.join(dir, "style-notes.txt"), styleSeed, "utf8");

  const { salt, hash } = hashPassword(password);
  const meta = {
    accountId,
    username: accountId,
    displayName: displayName || accountId,
    passwordSalt: salt,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };
  writeMeta(accountId, meta);
  return { accountId, displayName: meta.displayName };
}

function verifyPassword(username, password) {
  let accountId;
  try {
    accountId = assertValidUsername(username);
  } catch {
    return null;
  }
  const meta = readMeta(accountId);
  if (!meta) return null;
  if (!verifyPasswordHash(password, meta.passwordSalt, meta.passwordHash)) return null;

  meta.lastLoginAt = new Date().toISOString();
  writeMeta(accountId, meta);
  return { accountId, displayName: meta.displayName };
}

function changePassword(accountId, currentPassword, newPassword) {
  const meta = readMeta(accountId);
  if (!meta) throw new Error("アカウントが見つかりません。");
  if (!verifyPasswordHash(currentPassword, meta.passwordSalt, meta.passwordHash)) {
    throw new Error("現在のパスワードが正しくありません。");
  }
  if (!newPassword || newPassword.length < 8) {
    throw new Error("新しいパスワードは8文字以上にしてください。");
  }
  const { salt, hash } = hashPassword(newPassword);
  meta.passwordSalt = salt;
  meta.passwordHash = hash;
  writeMeta(accountId, meta);
}

function updateDisplayName(accountId, displayName) {
  const meta = readMeta(accountId);
  if (!meta) throw new Error("アカウントが見つかりません。");
  const trimmed = String(displayName || "").trim();
  if (!trimmed) throw new Error("表示名を入力してください。");
  meta.displayName = trimmed;
  writeMeta(accountId, meta);
  return { accountId, displayName: trimmed };
}

// --- 個人サンプル CRUD ---

function personalExamplesDir(accountId) {
  return resolvePaths(accountId).personalExamplesDir;
}

function listPersonalExamples(accountId) {
  const dir = personalExamplesDir(accountId);
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const items = files.map((f) => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return {
      id: record.id,
      title: record.title,
      preview: (record.content || "").slice(0, 60),
      createdAt: record.createdAt,
    };
  });
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

function getPersonalExample(accountId, id) {
  const dir = personalExamplesDir(accountId);
  const safeId = assertSafeId(id);
  const filePath = path.join(dir, `${safeId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function addPersonalExample(accountId, { title, content }) {
  const dir = personalExamplesDir(accountId);
  if (!dir) throw new Error("アカウントが指定されていません。");
  if (!content || !content.trim()) throw new Error("本文が空です。");
  fs.mkdirSync(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const id = `${createdAt.replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
  const record = { id, title: title || "", content: content.trim(), createdAt };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

function deletePersonalExample(accountId, id) {
  const dir = personalExamplesDir(accountId);
  const safeId = assertSafeId(id);
  const filePath = path.join(dir, `${safeId}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function loadPersonalExamplesText(accountId) {
  const dir = personalExamplesDir(accountId);
  if (!dir || !fs.existsSync(dir)) return "";
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const texts = files.map((f) => {
    const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    return record.content || "";
  });
  return texts.filter(Boolean).join("\n\n---\n\n");
}

module.exports = {
  assertSafeId,
  assertValidUsername,
  resolvePaths,
  accountExists,
  listAccounts,
  createAccount,
  verifyPassword,
  changePassword,
  updateDisplayName,
  listPersonalExamples,
  getPersonalExample,
  addPersonalExample,
  deletePersonalExample,
  loadPersonalExamplesText,
};
