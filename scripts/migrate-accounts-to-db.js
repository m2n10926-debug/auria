#!/usr/bin/env node
"use strict";

/**
 * 一度きり実行: ローカルファイルベースの accounts/ 配下のデータをPostgres DBへ移行する。
 *
 * 使い方:
 *   DATABASE_URL を .env に設定した上で実行:
 *   node scripts/migrate-accounts-to-db.js
 *
 * パスワードハッシュ/ソルトはそのまま引き継ぐため、本人は同じパスワードで
 * 引き続きログインできる。実行後、ローカルの accounts/ ディレクトリは削除してよい。
 */

const fs = require("fs");
const path = require("path");
const core = require("../lib/core");
const db = require("../lib/db");

core.loadDotEnvIfPresent();

const ACCOUNTS_DIR = path.join(core.ROOT, "accounts");

async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(sql);
  console.log("スキーマを確認・作成しました。");
}

async function migrateAccount(accountId) {
  const dir = path.join(ACCOUNTS_DIR, accountId);
  const metaPath = path.join(dir, "meta.json");
  if (!fs.existsSync(metaPath)) {
    console.log(`  [スキップ] ${accountId}: meta.json が見つかりません`);
    return;
  }
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));

  const existing = await db.query("SELECT 1 FROM accounts WHERE account_id = $1", [accountId]);
  if (existing.rows.length > 0) {
    console.log(`  [スキップ] ${accountId}: DBに既に存在します`);
    return;
  }

  const bannedWordsPath = path.join(dir, "banned-words.txt");
  const styleNotesPath = path.join(dir, "style-notes.txt");
  const bannedWordsRaw = fs.existsSync(bannedWordsPath) ? fs.readFileSync(bannedWordsPath, "utf8") : "";
  const styleNotesRaw = fs.existsSync(styleNotesPath) ? fs.readFileSync(styleNotesPath, "utf8") : "";

  await db.query(
    `INSERT INTO accounts
       (account_id, display_name, password_salt, password_hash, banned_words_raw, style_notes_raw, created_at, last_login_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      accountId,
      meta.displayName || accountId,
      meta.passwordSalt,
      meta.passwordHash,
      bannedWordsRaw,
      styleNotesRaw,
      meta.createdAt || new Date().toISOString(),
      meta.lastLoginAt || null,
    ]
  );
  console.log(`  [OK] アカウント ${accountId} (${meta.displayName}) を移行しました`);

  // 個人サンプル
  const examplesDir = path.join(dir, "examples");
  if (fs.existsSync(examplesDir)) {
    const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const record = JSON.parse(fs.readFileSync(path.join(examplesDir, f), "utf8"));
      await db.query(
        `INSERT INTO personal_examples (account_id, title, content, created_at) VALUES ($1, $2, $3, $4)`,
        [accountId, record.title || "", record.content || "", record.createdAt || new Date().toISOString()]
      );
    }
    if (files.length > 0) console.log(`    個人サンプル ${files.length}件を移行しました`);
  }

  // 履歴
  const historyDir = path.join(dir, "history");
  if (fs.existsSync(historyDir)) {
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const r = JSON.parse(fs.readFileSync(path.join(historyDir, f), "utf8"));
      await db.query(
        `INSERT INTO history (
           account_id, name, memo, output, recommendation, model,
           banned_hits, missing_headings, closing_repetition, missing_recommendation, consistency_warnings,
           height, weight, bust, type, age, occupation, impression, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [
          accountId,
          r.name,
          r.memo,
          r.output,
          r.recommendation || "",
          r.model,
          r.bannedHits || [],
          r.missingHeadings || [],
          !!r.closingRepetition,
          !!r.missingRecommendation,
          r.consistencyWarnings || [],
          r.height || null,
          r.weight || null,
          r.bust || null,
          r.type || null,
          r.age || null,
          r.occupation || null,
          r.impression || null,
          r.createdAt || new Date().toISOString(),
        ]
      );
    }
    if (files.length > 0) console.log(`    履歴 ${files.length}件を移行しました`);
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("エラー: 環境変数 DATABASE_URL が設定されていません。.env に設定してください。");
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(ACCOUNTS_DIR)) {
    console.log("accounts/ ディレクトリが存在しません。移行対象はありません。");
    return;
  }

  await ensureSchema();

  const accountIds = fs
    .readdirSync(ACCOUNTS_DIR)
    .filter((name) => fs.existsSync(path.join(ACCOUNTS_DIR, name, "meta.json")));

  if (accountIds.length === 0) {
    console.log("移行対象のアカウントが見つかりませんでした。");
    return;
  }

  console.log(`${accountIds.length}件のアカウントを移行します...`);
  for (const accountId of accountIds) {
    await migrateAccount(accountId);
  }
  console.log("\n移行完了です。DB上のデータを確認の上、ローカルの accounts/ ディレクトリは削除して構いません。");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("エラー:", err.message);
    process.exit(1);
  }
);
