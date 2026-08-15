#!/usr/bin/env node
"use strict";

/**
 * 管理者用: ログインアカウントを新規作成するCLI
 *
 * 使い方:
 *   node create-account.js [ユーザー名] [表示名]
 *
 * ユーザー名・表示名を省略した場合は対話入力になる。パスワードは常に対話入力（非表示）。
 */

const readline = require("readline");
const core = require("./lib/core");
const accounts = require("./lib/accounts");

core.loadDotEnvIfPresent();

function prompt(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const CTRL_C = String.fromCharCode(3);
const CTRL_D = String.fromCharCode(4);
const BACKSPACE_DEL = String.fromCharCode(127);

function promptHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    let input = "";
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const onData = (char) => {
      char = char.toString("utf8");
      if (char === "\n" || char === "\r" || char === CTRL_D) {
        if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input);
        return;
      }
      if (char === CTRL_C) {
        process.stdout.write("\n");
        process.exit(1);
        return;
      }
      if (char === BACKSPACE_DEL || char === "\b") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          if (stdin.isTTY) process.stdout.write("\b \b");
        }
        return;
      }
      input += char;
      if (stdin.isTTY) process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let username = args[0];
  let displayName = args[1];

  if (!username) username = await prompt("ユーザー名 (メールアドレス可。半角英数字と . _ % + - @ のみ): ");
  if (!displayName) displayName = await prompt("表示名 (例: 山田): ");

  const password = await promptHidden("パスワード (8文字以上): ");
  const password2 = await promptHidden("パスワード (確認): ");

  if (password !== password2) {
    console.error("エラー: パスワードが一致しません。");
    process.exitCode = 1;
    return;
  }

  try {
    const { accountId } = await accounts.createAccount({ username, displayName, password });
    console.log(`\nアカウントを作成しました: ${accountId} (${displayName})`);
    console.log(`このユーザー名とパスワードを本人に伝えてください。`);
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
