"use strict";

/**
 * GROUP BOARD（社内ID・権限ハブ）との連携。
 *
 * @unvs-seisaku/sdk はESM専用パッケージ（package.jsonのexportsに"require"条件が無い）
 * のため、CommonJSのこのプロジェクトからは動的import()でしか読み込めない。
 * gb/tokensの生成を初回アクセス時まで遅延させ、以降はキャッシュして使い回す。
 *
 * また同SDKはNext.jsの`cookies()`（リクエストごとに現在のreq/resを暗黙に解決する
 * API）を前提にしているため、Express向けにAsyncLocalStorageで同等のリクエスト
 * コンテキストを用意している。
 */

const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

function requestContextMiddleware(req, res, next) {
  als.run({ req, res }, next);
}

// GroupBoardのCookieAdapter契約: get()は同期、値は{value}またはundefined。
// req.cookiesは「リクエスト開始時点」のスナップショットなので、同一リクエスト内で
// set()した直後にget()しても反映されない（例: callbackでtokens.save()した直後に
// gb.permissions.can()がgetIdToken()経由で読もうとするケース）。
// そのためリクエストごとに書き込みキャッシュを持ち、set()した値をget()に反映する。
function currentCookieAdapter() {
  const store = als.getStore();
  if (!store) {
    throw new Error("GROUP BOARD: リクエストコンテキストの外からcookieにアクセスしようとしました。");
  }
  const { req, res } = store;
  if (!store.cookieWrites) store.cookieWrites = {};
  return {
    get(name) {
      const value = Object.prototype.hasOwnProperty.call(store.cookieWrites, name)
        ? store.cookieWrites[name]
        : req.cookies
        ? req.cookies[name]
        : undefined;
      return value === undefined ? undefined : { value };
    },
    set(name, value, options) {
      store.cookieWrites[name] = value;
      res.cookie(name, value, {
        httpOnly: options.httpOnly,
        sameSite: options.sameSite,
        path: options.path,
        secure: options.secure,
        maxAge: options.maxAge * 1000, // GroupBoardは秒、Expressはミリ秒
      });
    },
  };
}

let _gb;
let _tokens;
let _ready;

async function init() {
  const { GroupBoard, createSessionTokenStore } = await import("@unvs-seisaku/sdk");

  _gb = new GroupBoard({
    hubUrl: process.env.GROUPBOARD_URL,
    appId: process.env.GROUPBOARD_APP_ID,
    appClientSecret: process.env.GROUPBOARD_APP_CLIENT_SECRET,
    redirectUri: `${(process.env.GROUPBOARD_APP_URL || "").replace(/\/$/, "")}/api/auth/callback/groupboard`,
    getIdToken: () => _tokens.getIdToken(),
  });

  _tokens = createSessionTokenStore({
    secret: process.env.SESSION_SECRET || "change-me-in-.env",
    cookies: () => currentCookieAdapter(),
    groupBoard: () => _gb,
    onSessionLost: () => {
      // ここではredirectできない（呼び出し元がAPI/ページの両方あるため）。
      // 実際のリダイレクトはrequireAuth側でセッション不在として処理する。
    },
  });
}

function ensureReady() {
  if (!_ready) _ready = init();
  return _ready;
}

async function getGb() {
  await ensureReady();
  return _gb;
}

async function getTokens() {
  await ensureReady();
  return _tokens;
}

module.exports = { getGb, getTokens, requestContextMiddleware };
