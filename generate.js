#!/usr/bin/env node
"use strict";

/**
 * 会員紹介文 自動作成CLI
 *
 * 使い方:
 *   node generate.js --memo memos/sample.txt --name アリサ
 *   node generate.js --name アリサ < memos/sample.txt
 *   node generate.js --memo memos/sample.txt --name アリサ --out output/アリサ.txt
 *
 * 必須:
 *   環境変数 ANTHROPIC_API_KEY（または直下の .env に ANTHROPIC_API_KEY=... を記載）
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const core = require("./lib/core");

function parseArgs(argv) {
  const args = {
    memo: null,
    name: null,
    out: null,
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    height: null,
    weight: null,
    bust: null,
    type: null,
    age: null,
    occupation: null,
    impression: null,
    concerns: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--memo":
      case "-m":
        args.memo = argv[++i];
        break;
      case "--name":
      case "-n":
        args.name = argv[++i];
        break;
      case "--out":
      case "-o":
        args.out = argv[++i];
        break;
      case "--model":
        args.model = argv[++i];
        break;
      case "--height":
        args.height = argv[++i];
        break;
      case "--weight":
        args.weight = argv[++i];
        break;
      case "--bust":
        args.bust = argv[++i];
        break;
      case "--type":
        args.type = argv[++i];
        break;
      case "--age":
        args.age = argv[++i];
        break;
      case "--occupation":
        args.occupation = argv[++i];
        break;
      case "--impression":
        args.impression = argv[++i];
        break;
      case "--concerns":
        args.concerns = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        console.error(`不明なオプションです: ${a}`);
        args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`会員紹介文 自動作成CLI

使い方:
  node generate.js --memo <面接メモファイル> --name <会員の呼び名> [--out <出力ファイル>] [--model <モデルID>]
  node generate.js --name <会員の呼び名> < <面接メモファイル>   (標準入力から読み込み)

オプション:
  -m, --memo   面接メモのテキストファイルパス（省略時は標準入力から読み込み）
  -n, --name   会員の呼び名（【最後に】で使用）※必須
  -o, --out    生成した紹介文の保存先ファイルパス（省略時は標準出力に表示のみ）
      --model  使用するAnthropicモデルID（既定値: claude-sonnet-5、環境変数 ANTHROPIC_MODEL でも指定可）
      --height 身長(cm)。【ルックス】の参考情報として使用（任意）
      --weight 体重(kg)。【ルックス】の参考情報として使用（任意）
      --bust   バスト(カップ等)。【ルックス】の参考情報として使用（任意）
      --type   交際タイプ(A/B1/B2/C/D)。【交際タイプ】冒頭の定型文に使用（任意）
      --age    年齢。文脈に応じて【登録動機】等に反映（任意）
      --occupation 職業。文脈に応じて【登録動機】等に反映（任意）
      --impression 担当者から見た印象（本人の発言=メモとは別の、担当者自身の所感）。【性格】に活用（任意）
      --concerns   【懸念点】見出しを追加する（任意。指定しない場合は6見出しのまま）
  -h, --help   このヘルプを表示

必要な環境変数:
  ANTHROPIC_API_KEY   Anthropic APIキー（直下の .env ファイルでも指定可）

ヒント:
  画面から使いたい場合は \`npm run web\` でローカルWebアプリを起動できます。
`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(
        new Error(
          "面接メモが指定されていません。--memo でファイルを指定するか、標準入力にメモを流し込んでください。"
        )
      );
      return;
    }
    let data = "";
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", (line) => (data += line + "\n"));
    rl.on("close", () => resolve(data));
    rl.on("error", reject);
  });
}

async function main() {
  core.loadDotEnvIfPresent();
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  if (!args.name) {
    console.error("エラー: --name (会員の呼び名) は必須です。\n");
    printHelp();
    process.exitCode = 1;
    return;
  }

  let memo;
  try {
    if (args.memo) {
      memo = fs.readFileSync(args.memo, "utf8");
    } else {
      memo = await readStdin();
    }
  } catch (err) {
    console.error(`エラー: 面接メモの読み込みに失敗しました。 ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.error(`紹介文を生成しています... (model: ${args.model})`);

  let result;
  try {
    result = await core.generateIntro({
      memo,
      name: args.name,
      model: args.model,
      height: args.height,
      weight: args.weight,
      bust: args.bust,
      type: args.type,
      age: args.age,
      occupation: args.occupation,
      impression: args.impression,
      includeConcerns: args.concerns,
    });
  } catch (err) {
    console.error(`エラー: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const {
    output,
    recommendation,
    bannedHits,
    missingHeadings,
    closingRepetition,
    missingRecommendation,
    consistencyWarnings,
  } = result;

  if (bannedHits.length > 0) {
    console.error(
      `\n[警告] 出力に禁止ワードが含まれている可能性があります: ${bannedHits.join(", ")}`
    );
    console.error("内容を必ず目視確認し、必要に応じて修正してください。\n");
  }
  if (missingHeadings.length > 0) {
    console.error(
      `[警告] 想定される見出しが出力に含まれていません: ${missingHeadings.join(", ")}\n`
    );
  }
  if (closingRepetition) {
    console.error(
      `[警告] 【最後に】で「お待ちしております」等が重複している可能性があります。目視確認してください。\n`
    );
  }
  if (missingRecommendation) {
    console.error(`[警告] 「おすすめの男性像」が生成されませんでした。\n`);
  }
  if (consistencyWarnings.length > 0) {
    console.error(`[矛盾チェック] 以下の点を確認してください:`);
    consistencyWarnings.forEach((w) => console.error(`  - ${w}`));
    console.error("");
  }

  core.saveHistory({
    name: args.name,
    memo,
    output,
    recommendation,
    model: result.model,
    bannedHits,
    missingHeadings,
    closingRepetition,
    missingRecommendation,
    consistencyWarnings,
    height: args.height,
    weight: args.weight,
    bust: args.bust,
    type: args.type,
    age: args.age,
    occupation: args.occupation,
    impression: args.impression,
  });

  const fullText = recommendation
    ? `${output}\n\n【こんな男性におすすめ】\n${recommendation}`
    : output;

  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, fullText, "utf8");
    console.error(`保存しました: ${args.out}`);
  } else {
    console.log(fullText);
  }
}

main();
