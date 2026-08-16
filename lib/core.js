"use strict";

/**
 * 会員紹介文 自動作成 共有ロジック
 * CLI (generate.js) とWebサーバー (server.js) の両方から利用する。
 *
 * accountId が未指定（CLI経路）の関数はすべて同期・ファイルベースのまま維持する。
 * accountId が指定された場合（Webアプリ経路）は lib/accounts.js 経由でDB（Postgres）を使い、
 * 該当する関数はPromiseを返す。呼び出し側は常に await すれば両経路に対応できる
 * （非Promise値をawaitしてもそのまま即時に解決されるため、CLI経路は挙動が変わらない）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const STYLE_GUIDE_PATH = path.join(ROOT, "style-guide.md");
const EXAMPLES_DIR = path.join(ROOT, "examples");
const BANNED_WORDS_PATH = path.join(ROOT, "banned-words.txt");
const STYLE_NOTES_PATH = path.join(ROOT, "style-notes.txt");
const HISTORY_DIR = path.join(ROOT, "history");

const DEFAULT_STYLE_NOTES = `# 文章の癖・スタイル指示
# ここに書いた内容は、生成される文章の癖・トーンの好みとして反映されます。自由に編集してください。
# 見出し構成や禁止ワードなど style-guide.md の中核ルールの方が優先されます（矛盾する内容は無視されます）。

- 文末の「！」を毎文使うのではなく、3〜5文に1回程度に抑え、「〜と感じました。」「〜という印象です。」のような「。」で終わる文も適度に混ぜる。
`;

const REQUIRED_HEADINGS = [
  "【登録動機】",
  "【交際タイプ】",
  "【ルックス】",
  "【性格】",
  "【金銭感覚】",
  "【最後に】",
];

const CONCERNS_HEADING = "【懸念点】";
const MAX_CUSTOM_HEADINGS = 5;
const MAX_HEADING_GUIDANCE_LENGTH = 500;

// 見出し構成のカスタマイズ（アカウントごと、任意）。
// structure は正規化済みの配列 [{ key, custom, enabled, guidance }] または null（未カスタマイズ=既定の6見出し）。

function getDefaultHeadingStructure() {
  return REQUIRED_HEADINGS.map((key) => ({ key, custom: false, enabled: true, guidance: "" }));
}

function normalizeHeadingStructureInput(headings) {
  if (!Array.isArray(headings)) {
    throw new Error("見出し構成の形式が不正です。");
  }
  const seen = new Set();
  const normalized = [];
  let customCount = 0;

  for (const raw of headings) {
    if (!raw || typeof raw !== "object") continue;
    let key = String(raw.key || "").trim();
    if (!key) continue;
    if (!key.startsWith("【")) key = `【${key}`;
    if (!key.endsWith("】")) key = `${key}】`;
    if (key === CONCERNS_HEADING) {
      throw new Error(
        "「【懸念点】」は生成画面のチェックボックスで別途ON/OFFする専用の見出しのため、ここでは追加できません。"
      );
    }
    if (seen.has(key)) {
      throw new Error(`見出し名が重複しています: ${key}`);
    }
    seen.add(key);

    const isCustom = !REQUIRED_HEADINGS.includes(key);
    if (isCustom) {
      customCount++;
      if (customCount > MAX_CUSTOM_HEADINGS) {
        throw new Error(`独自の見出しは最大${MAX_CUSTOM_HEADINGS}個までです。`);
      }
    }
    normalized.push({
      key,
      custom: isCustom,
      enabled: raw.enabled !== false,
      guidance: isCustom ? String(raw.guidance || "").trim().slice(0, MAX_HEADING_GUIDANCE_LENGTH) : "",
    });
  }

  for (const h of REQUIRED_HEADINGS) {
    if (!seen.has(h)) normalized.push({ key: h, custom: false, enabled: true, guidance: "" });
  }

  if (!normalized.some((h) => h.enabled)) {
    throw new Error("有効な見出しが1つもありません。少なくとも1つは有効にしてください。");
  }

  return normalized;
}

function parseHeadingStructureRaw(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // 壊れたデータの場合は既定構成へ安全にフォールバックする
  }
  return null;
}

function getRequiredHeadings(includeConcerns = false, structure = null) {
  const list =
    structure && structure.length
      ? structure.filter((h) => h.enabled !== false).map((h) => h.key)
      : [...REQUIRED_HEADINGS];
  if (!includeConcerns) return list;
  const idx = Math.max(list.length - 1, 0);
  return [...list.slice(0, idx), CONCERNS_HEADING, ...list.slice(idx)];
}

function getCustomHeadingGuidance(structure) {
  if (!structure) return [];
  return structure.filter((h) => h.custom && h.enabled !== false && h.guidance && h.guidance.trim());
}

function getDisabledDefaultHeadings(structure) {
  if (!structure) return [];
  const enabledKeys = new Set(structure.filter((h) => h.enabled !== false).map((h) => h.key));
  return REQUIRED_HEADINGS.filter((h) => !enabledKeys.has(h));
}

const RECOMMEND_MARKER = "###RECOMMEND###";

// 矛盾チェックは単純な照合タスクのため、本文生成より高速なモデルを使い、
// 合計処理時間（Vercelの関数タイムアウト）を短縮する。
const CONSISTENCY_CHECK_MODEL = process.env.CONSISTENCY_MODEL || "claude-haiku-4-5-20251001";

function loadDotEnvIfPresent() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadStyleGuide() {
  return fs.readFileSync(STYLE_GUIDE_PATH, "utf8");
}

function loadSharedExamples() {
  if (!fs.existsSync(EXAMPLES_DIR)) return "";
  const files = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
    .sort();
  return files
    .map((f) => fs.readFileSync(path.join(EXAMPLES_DIR, f), "utf8"))
    .join("\n\n---\n\n");
}

function loadExamples(accountId = null) {
  const shared = loadSharedExamples();
  if (!accountId) return shared;
  return require("./accounts")
    .loadPersonalExamplesText(accountId)
    .then((personal) => [shared, personal].filter(Boolean).join("\n\n---\n\n"));
}

function parseBannedWordsText(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function loadBannedWords(accountId = null) {
  if (!accountId) return parseBannedWordsText(readBannedWordsRaw());
  return readBannedWordsRaw(accountId).then(parseBannedWordsText);
}

function readBannedWordsRaw(accountId = null) {
  if (!accountId) {
    if (!fs.existsSync(BANNED_WORDS_PATH)) return "";
    return fs.readFileSync(BANNED_WORDS_PATH, "utf8");
  }
  return require("./accounts").getBannedWordsRaw(accountId);
}

function writeBannedWordsRaw(text, accountId = null) {
  if (!accountId) {
    fs.writeFileSync(BANNED_WORDS_PATH, text, "utf8");
    return;
  }
  return require("./accounts").setBannedWordsRaw(accountId, text);
}

function parseStyleNotesText(raw) {
  return raw
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
}

function loadStyleNotes(accountId = null) {
  if (!accountId) return parseStyleNotesText(readStyleNotesRaw());
  return readStyleNotesRaw(accountId).then(parseStyleNotesText);
}

function readStyleNotesRaw(accountId = null) {
  if (!accountId) {
    if (!fs.existsSync(STYLE_NOTES_PATH)) return DEFAULT_STYLE_NOTES;
    return fs.readFileSync(STYLE_NOTES_PATH, "utf8");
  }
  return require("./accounts").getStyleNotesRaw(accountId);
}

function writeStyleNotesRaw(text, accountId = null) {
  if (!accountId) {
    fs.writeFileSync(STYLE_NOTES_PATH, text, "utf8");
    return;
  }
  return require("./accounts").setStyleNotesRaw(accountId, text);
}

function buildSystemPrompt(
  styleGuide,
  examples,
  bannedWords,
  styleNotes,
  includeConcerns = false,
  headingStructure = null
) {
  const bannedList = bannedWords.map((w) => `- ${w}`).join("\n");
  const styleNotesBlock = styleNotes && styleNotes.trim()
    ? `\n# 追加の文体指示（担当者が設定した好み。中核ルールと矛盾する場合は中核ルールを優先すること）\n${styleNotes.trim()}\n`
    : "";
  const headings = getRequiredHeadings(includeConcerns, headingStructure);
  const headingsList = headings.join("");
  const concernsInstruction = includeConcerns
    ? `\n- 【懸念点】には、面接メモ・担当者の印象から読み取れる選考・マッチング上の留意点を、誇張せず、無理にフォロー（言い訳・弁明）を加えず、端的な事実ベースで書くこと。特に懸念点が見当たらない場合は「特に大きな懸念点は見られません。」程度の短い一文にとどめること。`
    : `\n- 今回は【懸念点】を含める指定がされていない。スタイルガイド内に【懸念点】の説明があっても、面接メモの内容に気になる点が読み取れたとしても、【懸念点】の見出しは絶対に追加しないこと（指定が無い限り常に既定の見出し構成のみ）。`;
  const disabledHeadings = getDisabledDefaultHeadings(headingStructure);
  const disabledInstruction = disabledHeadings.length
    ? `\n- 次の見出しは今回のアカウント設定で無効化されているため、絶対に出力しないこと: ${disabledHeadings.join("、")}`
    : "";
  const customGuidanceList = getCustomHeadingGuidance(headingStructure);
  const customHeadingsBlock = customGuidanceList.length
    ? `\n\n# 担当者が追加設定した独自の見出しについて\n${customGuidanceList
        .map((h) => `- ${h.key}: ${h.guidance}`)
        .join("\n")}\nこれらの独自の見出しについても、スタイルガイドの禁止事項・文体ルールは同様に適用すること。`
    : "";
  return `あなたは結婚相談所・交際クラブ向けの会員紹介文ライターです。
以下のスタイルガイドに厳密に従い、面接メモをもとに会員紹介文の下書きを作成してください。

# スタイルガイド
${styleGuide}
${styleNotesBlock}
# 禁止ワード（出力に一切含めないこと）
${bannedList || "(なし)"}

# 過去の紹介文サンプル（文体・構成の参考。内容はそのまま使い回さないこと）
${examples || "(サンプルなし)"}

# 出力ルール
- 上記スタイルガイドの${headings.length}見出し構成（${headingsList}）をこの順番で必ず使用すること。
- 見出し以外の前置き・後書き・説明文（「以下が紹介文です」等）は一切出力しないこと。
- 面会頻度と金額を紐づけた対価表現（例:「月◯回で◯万円」）は、メモにその情報があっても絶対に出力しないこと。
- 【金銭感覚】は一般的な金銭感覚の描写のみとし、具体的な金額を対価として提示しないこと。
- メモに書かれていない事実を創作しないこと（誇張は避け、印象表現の範囲に留める）。${concernsInstruction}${disabledInstruction}${customHeadingsBlock}

# 追加出力：おすすめの男性像
倶楽部コメントを出力し終えたら、改行を2つ挟んで ${RECOMMEND_MARKER} という行だけを出力し、
その次の行から「こんな男性におすすめです！」という趣旨の内容を2〜3文程度、通常の文体（「！」多用）で出力すること。
- この部分に見出しは付けない。
- 会員の性格・交際タイプ・登録動機などから読み取れる、相性の良さそうな男性像（性格・雰囲気・年齢層など）を書く。
- ${RECOMMEND_MARKER} より前後で、面会頻度と金額を紐づけた対価表現や、対価を連想させる単語・直接的な性表現は使わないこと（禁止事項は倶楽部コメントと同様に適用される）。`;
}

function buildReferenceInfo(memo, name, details = {}) {
  const { height, weight, bust, type, age, occupation, impression } = details;

  const basicLines = [];
  if (age) basicLines.push(`年齢: ${age}歳`);
  if (occupation) basicLines.push(`職業: ${occupation}`);
  const basicInfoBlock = basicLines.length
    ? `\n\n# 基本情報\n${basicLines.join("\n")}`
    : "";

  const bodyLines = [];
  if (height) bodyLines.push(`身長: ${height}cm`);
  if (weight) bodyLines.push(`体重: ${weight}kg`);
  if (bust) bodyLines.push(`バスト: ${bust}`);
  const bodyInfoBlock = bodyLines.length
    ? `\n\n# 身体的特徴（【ルックス】の参考情報）\n${bodyLines.join("\n")}\n※数値をそのまま列挙するのではなく、体型・雰囲気の印象として自然な文章に反映すること。`
    : "";

  const typeBlock = type
    ? `\n\n# 交際タイプ\n${type}タイプ\n※【交際タイプ】の最初の一文は、必ず次の文をそのまま使うこと（文末は「！」ではなく「。」）：\n「面接時は${type}タイプを選択されました。」\nそれに続けて、このタイプの意味を踏まえた内容を自然な文章（それ以降は通常通り「！」を使ってよい）で続けること。`
    : "";

  const impressionBlock =
    impression && impression.trim()
      ? `\n\n# 担当者から見た印象（本人の発言ではなく、面接した担当者自身の観察・所感）\n${impression.trim()}\n※面接メモ（本人の発言）とは別の、信頼できる参考情報。内容に応じて【登録動機】【交際タイプ】【ルックス】【性格】【金銭感覚】のうち関連する見出しに自然に反映すること（【性格】に限定しない）。例えば外見に関する所感なら【ルックス】に、金銭感覚に関する所感なら【金銭感覚】に、というように内容に合った見出しで使うこと。`
      : "";

  return `# 面接メモ（本人から聞いた情報）
${memo.trim()}

# 会員の呼び名
${name}${basicInfoBlock}${bodyInfoBlock}${typeBlock}${impressionBlock}`;
}

function buildUserPrompt(memo, name, details = {}) {
  return `${buildReferenceInfo(memo, name, details)}

上記の情報をもとに、スタイルガイドに従って会員紹介文を作成してください。`;
}

function checkBannedWords(text, bannedWords) {
  const hits = [];
  for (const word of bannedWords) {
    if (word && text.includes(word)) hits.push(word);
  }
  return hits;
}

function checkHeadings(text, includeConcerns = false, headingStructure = null) {
  return getRequiredHeadings(includeConcerns, headingStructure).filter((h) => !text.includes(h));
}

function checkClosingRepetition(text) {
  const matches = text.match(/お待ちして(おります|います)/g) || [];
  return matches.length > 1;
}

function parseConsistencyResponse(text) {
  const trimmed = (text || "").trim();
  if (!trimmed || /^問題なし[。.!！]*$/.test(trimmed)) return [];
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-・*]\s*/, "").trim())
    .filter(Boolean);
  return lines.length ? lines : [trimmed];
}

async function checkConsistency(client, model, referenceInfo, output) {
  const prompt = `以下は、担当者が入力した会員の面接メモ・基本情報と、それを元にAIが生成した会員紹介コメントです。
入力情報の内容が誤って結合されたり、事実と異なる形で書かれていないかを確認してください。
（例：メモに「大学は都内」「仕事は事務」と別々に書かれているのに、コメントで「都内の大学に通いながら事務の仕事をしている」のように誤って一つの事実として結合されてしまうケースなど）
なお、「基本情報」「身体的特徴」「交際タイプ」として渡されている項目は、面接メモとは別に担当者が入力した正規の情報なので、
それらの内容がコメントに反映されていること自体は矛盾・事実誤認として指摘しないでください。

# 担当者が入力した情報
${referenceInfo}

# 生成されたコメント
${output}

矛盾や事実誤認の可能性がある箇所があれば、1件につき1行の箇条書き（「- 」から始める）で簡潔に指摘してください。
問題が見つからない場合は「問題なし」とだけ出力してください。それ以外の説明や前置きは出力しないでください。`;

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
    thinking: { type: "disabled" },
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return parseConsistencyResponse(text);
}

async function generateIntro({
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
  includeConcerns = false,
  accountId = null,
}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "環境変数 ANTHROPIC_API_KEY が設定されていません。.env ファイルに ANTHROPIC_API_KEY=sk-ant-... を記載するか、環境変数を設定してください。"
    );
  }
  if (!memo || !memo.trim()) {
    throw new Error("面接メモの内容が空です。");
  }
  if (!name || !name.trim()) {
    throw new Error("会員の呼び名が指定されていません。");
  }

  const styleGuide = loadStyleGuide();
  const examples = await loadExamples(accountId);
  const bannedWords = await loadBannedWords(accountId);
  const styleNotes = await loadStyleNotes(accountId);
  const headingStructure = accountId
    ? parseHeadingStructureRaw(await require("./accounts").getHeadingStructureRaw(accountId))
    : null;

  const details = { height, weight, bust, type, age, occupation, impression };
  const referenceInfo = buildReferenceInfo(memo, name, details);
  const systemPrompt = buildSystemPrompt(
    styleGuide,
    examples,
    bannedWords,
    styleNotes,
    includeConcerns,
    headingStructure
  );
  const userPrompt = buildUserPrompt(memo, name, details);

  const Anthropic = require("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const usedModel = model || process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const response = await client.messages.create({
    model: usedModel,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
    thinking: { type: "disabled" },
  });

  const rawText = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const markerIndex = rawText.indexOf(RECOMMEND_MARKER);
  const output = (markerIndex === -1 ? rawText : rawText.slice(0, markerIndex)).trim();
  const recommendation =
    markerIndex === -1 ? "" : rawText.slice(markerIndex + RECOMMEND_MARKER.length).trim();

  const bannedHits = checkBannedWords(`${output}\n${recommendation}`, bannedWords);
  const missingHeadings = checkHeadings(output, includeConcerns, headingStructure);
  const closingRepetition = checkClosingRepetition(output);
  const missingRecommendation = !recommendation;

  const consistencyWarnings = await checkConsistency(
    client,
    CONSISTENCY_CHECK_MODEL,
    referenceInfo,
    output
  );

  return {
    output,
    recommendation,
    model: usedModel,
    bannedHits,
    missingHeadings,
    closingRepetition,
    missingRecommendation,
    consistencyWarnings,
  };
}

function saveHistory({
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
  accountId = null,
}) {
  const record = {
    name,
    memo,
    output,
    recommendation: recommendation || "",
    model,
    bannedHits: bannedHits || [],
    missingHeadings: missingHeadings || [],
    closingRepetition: !!closingRepetition,
    missingRecommendation: !!missingRecommendation,
    consistencyWarnings: consistencyWarnings || [],
    height: height || null,
    weight: weight || null,
    bust: bust || null,
    type: type || null,
    age: age || null,
    occupation: occupation || null,
    impression: impression || null,
  };

  if (!accountId) {
    const { historyDir } = require("./accounts").resolvePaths();
    fs.mkdirSync(historyDir, { recursive: true });
    const createdAt = new Date().toISOString();
    const id = `${createdAt.replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
    const fileRecord = { id, createdAt, ...record };
    fs.writeFileSync(path.join(historyDir, `${id}.json`), JSON.stringify(fileRecord, null, 2), "utf8");
    return fileRecord;
  }

  return require("./accounts").saveHistory(accountId, record);
}

function listHistory(accountId = null) {
  if (!accountId) {
    const { historyDir } = require("./accounts").resolvePaths();
    if (!fs.existsSync(historyDir)) return [];
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith(".json"));
    const records = files.map((f) => {
      const record = JSON.parse(fs.readFileSync(path.join(historyDir, f), "utf8"));
      return {
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        preview: (record.output || "").slice(0, 60),
      };
    });
    records.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return records;
  }
  return require("./accounts").listHistory(accountId);
}

function getHistory(id, accountId = null) {
  if (!accountId) {
    const { historyDir } = require("./accounts").resolvePaths();
    const safeId = path.basename(id);
    const filePath = path.join(historyDir, `${safeId}.json`);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  return require("./accounts").getHistory(accountId, id);
}

module.exports = {
  ROOT,
  BANNED_WORDS_PATH,
  STYLE_NOTES_PATH,
  HISTORY_DIR,
  EXAMPLES_DIR,
  REQUIRED_HEADINGS,
  CONCERNS_HEADING,
  MAX_CUSTOM_HEADINGS,
  getRequiredHeadings,
  getDefaultHeadingStructure,
  normalizeHeadingStructureInput,
  parseHeadingStructureRaw,
  loadDotEnvIfPresent,
  loadStyleGuide,
  loadExamples,
  loadBannedWords,
  readBannedWordsRaw,
  writeBannedWordsRaw,
  loadStyleNotes,
  readStyleNotesRaw,
  writeStyleNotesRaw,
  buildSystemPrompt,
  buildUserPrompt,
  checkBannedWords,
  checkHeadings,
  checkClosingRepetition,
  generateIntro,
  saveHistory,
  listHistory,
  getHistory,
};
