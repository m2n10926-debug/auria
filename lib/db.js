"use strict";

/**
 * Postgres接続（軽量ラッパー）。ORMは使わず pg を直接利用する。
 * DATABASE_URL が未設定の場合はCLI用途（DB非依存）とみなし、
 * 呼び出し側（lib/accounts.js）でDB関数が呼ばれない限りエラーにはならない。
 */

const { Pool } = require("pg");

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "環境変数 DATABASE_URL が設定されていません。.env に Postgres の接続文字列を設定してください。"
      );
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

module.exports = { query };
