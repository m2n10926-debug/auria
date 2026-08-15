# intro-writer

面接メモから会員紹介文の下書きを自動生成するCLIツール。

## セットアップ

```bash
cd intro-writer
npm install
cp .env.example .env
```

`.env` を開き、`ANTHROPIC_API_KEY` に自分のAnthropic APIキーを設定してください。
Webアプリ（ログイン機能あり）を使う場合は `DATABASE_URL`（Postgres接続文字列）と `SESSION_SECRET`
も必ず設定してください（生成例は`.env.example`のコメント参照）。

## 使い方

ファイルから読み込む場合:

```bash
node generate.js --memo memos/sample.txt --name アリサ
```

標準入力から貼り付ける場合:

```bash
node generate.js --name アリサ < memos/sample.txt
```

ファイルに保存する場合:

```bash
node generate.js --memo memos/sample.txt --name アリサ --out output/アリサ.txt
```

オプション一覧は `node generate.js --help` を参照。

## Webアプリ（画面から使う・アカウントログインあり）

CLIの代わりにブラウザから使うこともできます。複数人で使う場合、アカウントごとに
ログインし、禁止ワード・文章の癖・自分の過去サンプル・履歴がそれぞれ個別にPostgres DBへ保存されます
（CLIはこれまで通りローカルファイルのままです。詳細は「アーキテクチャ」節を参照）。

```bash
npm run web
```

起動後、ブラウザで `http://localhost:3000` を開くとログイン画面が表示されます。

### アカウントの発行

Webからの自由登録はできません（APIコスト悪用防止のため）。管理者が以下のコマンドで発行し、
発行したユーザー名・パスワードを本人に伝えてください。

```bash
node create-account.js
```

対話形式でユーザー名（メールアドレス可。半角英数字と `. _ % + - @` のみ使用可）・表示名・パスワード（8文字以上）を入力します。
`node create-account.js ユーザー名 表示名` のように引数で一部省略も可能です（パスワードは常に対話入力）。

新規アカウントの禁止ワード・文章の癖は、作成時点のルート直下の `banned-words.txt` / `style-notes.txt`
の内容をコピーして初期値にします。以後はアカウントごとに個別編集できます（DBに保存されます）。

`create-account.js` は `.env` の `DATABASE_URL` を使ってDBに接続するため、ローカルの `.env` を
本番（Vercel Postgres）の接続文字列に向けておけば、手元から直接本番アカウントを発行できます。

### ログイン後の画面

- **生成**: 面接メモ・基本情報を入力して紹介文を生成（CLIと同じロジック）
- **履歴**: 自分の生成結果のみを一覧・詳細表示。「この内容を生成タブに戻す」で再利用可能
- **AI設定**:
  - **自分の紹介文サンプル**: 過去に自分で書いた紹介文を登録すると、会社共通のサンプルに加えて
    自分の文体に寄せた生成の参考として使われます
  - **パスワード変更**
  - **文章の癖・スタイル指示** / **禁止ワード**（アカウントごとに個別設定）

CLIとWebアプリは生成ロジックを共有しており（`lib/core.js`）、CLIはこれまで通りログイン概念を持たず
ルート直下の共有ファイル・`history/`をそのまま使います。

ポートを変更したい場合は `PORT` 環境変数を指定してください（例: `PORT=4000 npm run web`）。

### アーキテクチャ（CLI と Webアプリでデータの持ち方が違う）

| | CLI (`generate.js`) | Webアプリ (`server.js`) |
|---|---|---|
| 実行環境 | ローカルPC | Vercel（サーバーレス）想定 |
| 禁止ワード・文章の癖 | ルート直下の `banned-words.txt` / `style-notes.txt` | アカウントごとにPostgres DBに保存 |
| 履歴・個人サンプル | ルート直下の `history/`（ファイル） | Postgres DB（アカウントごと） |
| ログイン | なし | あり |

`style-guide.md`・`examples/`（会社共通サンプル）は両方から共通で参照する読み取り専用ファイルで、
DB化していません。

### Vercelへのデプロイ

1. [Vercel](https://vercel.com)でアカウント作成し、このGitHubリポジトリと連携する
2. VercelプロジェクトにPostgres（Vercel Postgres / Neon）を追加し、接続文字列を取得する
3. Vercelのプロジェクト設定 → Environment Variablesに、`.env.example`と同じ変数
   （`ANTHROPIC_API_KEY`, `DATABASE_URL`, `SESSION_SECRET`, `TRUST_PROXY=1` など）を設定する
4. デプロイ後、ローカルの `.env` の `DATABASE_URL` も同じ接続文字列に設定し、
   `node create-account.js` で本番用アカウントを発行する
5. 既存のローカルアカウント（`accounts/`配下）がある場合は、先に
   `node scripts/migrate-accounts-to-db.js` を実行してDBへ移行しておく（パスワードは引き継がれる）

`vercel.json`で`maxDuration`（生成処理がAPIを2回呼ぶため余裕を持って30秒）と、
`public/`・`public-auth/`・`examples/`・`style-guide.md`のバンドル対象指定（`includeFiles`）を設定済みです。

### インターネット公開する場合（自前のリバースプロキシ等を使う場合）

- `.env` の `NODE_ENV=production` にすると、Cookieの`secure`属性が有効になります（HTTPS必須）
- リバースプロキシ（Caddy/nginx等）でHTTPS終端する場合は `TRUST_PROXY=1` を設定してください
- ドメイン・HTTPS証明書・ホスティング環境の用意は別途必要です（本アプリのコードはリバースプロキシの
  背後で動く前提の設定までを行います）

## ファイル構成

- `style-guide.md` — 文体・見出し構成・禁止事項の中核ルール（全アカウント共有・不変）
- `examples/` — 会社共通の過去の紹介文サンプル（few-shot用、匿名化必須。全アカウント共有）
- `banned-words.txt` / `style-notes.txt` — 禁止ワード/文章の癖のデフォルト値（新規アカウント作成時のシード元。CLIはこのルート直下ファイルをそのまま使う）
- `lib/core.js` — CLI/Webアプリ共通の生成ロジック
- `lib/accounts.js` — アカウントごとのデータ分離・パスワード認証（Postgres DB使用）
- `lib/db.js` — Postgres接続（`pg`の薄いラッパー）
- `lib/auth.js` — ログイン必須化のミドルウェア
- `generate.js` — CLIスクリプト（ログイン概念なし、ローカルファイルを使用）
- `create-account.js` — 管理者用: ログインアカウント発行CLI（DBに書き込む）
- `server.js` — Webアプリ（Express）サーバー本体
- `api/index.js` — Vercel Serverless Functions用のエントリポイント（`server.js`をそのままexport）
- `vercel.json` — Vercelのデプロイ設定（タイムアウト・静的ファイルのバンドル指定等）
- `scripts/schema.sql` — Postgresのテーブル定義
- `scripts/migrate-accounts-to-db.js` — ローカルaccounts/配下のデータをDBへ移行する一度きりのスクリプト
- `public-auth/` — ログイン画面（未ログインでもアクセス可能）
- `public/` — ログイン後のWebアプリ本体（HTML/CSS/JS）
- `accounts/` — （移行前の名残）CLI由来のローカルアカウントデータ。Webアプリは現在DBを使うため参照しない
- `memos/` — CLI用の入力メモ置き場（`.gitignore` 対象。個人情報を含むため外部共有しない）
- `history/` — CLI用の生成履歴（`.gitignore` 対象。個人情報を含むため外部共有しない）

## 中核制約（変更時も維持すること）

1. 出力見出しは【登録動機】【交際タイプ】【ルックス】【性格】【金銭感覚】【最後に】の6つのみ、この順番で固定。
2. 面会頻度と金額を紐づけた対価表現（例:「月2回で3万円」）は、プロンプト・入力メモの両段階で除外し、出力に一切含めない。

詳細は [style-guide.md](style-guide.md) を参照してください。

## 注意事項

- 生成結果は必ず人間が目視確認してから使用してください（禁止ワードチェックはあくまで保険です）。
- メモ・生成結果は個人情報を含むため、ローカル保存を基本とし、外部送信は生成リクエスト時のみに限定してください。
