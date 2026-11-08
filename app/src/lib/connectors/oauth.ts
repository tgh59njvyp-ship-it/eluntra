import { getState, update } from "../store";

/**
 * コネクタの「押すとログイン画面に飛んで、ログインしたら繋がる」接続基盤。
 *
 * ■ GitHub：デバイスフローを実装済み。ただし接続先のGitHubアプリ（ログイン用と
 *   同一アプリ）でデバイスフローが有効化されていないと開始できない。
 *   2026-11-08 の実測では POST https://github.com/login/device/code が
 *   {"error":"device_flow_disabled"} を返した（＝アプリ側の設定がまだ必要）。
 *   有効化されれば、このコードのままコード表示→ポーリング→接続まで通る。
 *   GitHubのデバイス系エンドポイントはCORSヘッダーを返さないため、ブラウザからは
 *   Vercelの中継 /api/oauth/github-device 経由で呼ぶ。
 *
 * ■ その他のサービス：認可コード＋PKCE の汎用エンジンと設定テーブルを用意済み。
 *   トークン交換は client_secret が必要なため Vercel の /api/oauth/exchange が行う。
 *   secret は Vercel 環境変数 OAUTH_<SERVICE>_CLIENT_ID / _CLIENT_SECRET に
 *   登録する設計で、現時点では未登録。未登録のサービスは認可画面へ飛ばす前に
 *   アプリ内で「アプリ登録が必要」という説明を表示する（oauthReady() が false）。
 *
 * client_id は公開値のためアプリに組み込む（secret は当然含まない）。
 * GITHUB_CLIENT_ID / GOOGLE_CLIENT_ID は、Supabaseログインで使われている
 * 既存OAuthアプリのもの（2026-11-08 に authorize リダイレクトから取得）。
 * ただし Google のリダイレクトURIは Supabase コールバック専用に登録されている
 * ため、コネクタ用には REDIRECT_URI の追加登録が別途必要。
 */

export const REDIRECT_URI = "https://eluntra.vercel.app/connectors/callback";

const GITHUB_CLIENT_ID = "Ov23livoDT2raVlwV2o1";
const GOOGLE_CLIENT_ID = "743031984555-f4b1v8tsqkp7o2jqopiifgkgfblg88c5.apps.googleusercontent.com";
/* Supabase Management API OAuth アプリの client_id（公開値）。
   アプリ登録が完了したら、ここに値を入れて OAUTH_SERVICES.supabase の
   clientIdKnown を true にするとログイン式接続が有効になる。
   あわせて Vercel 環境変数 OAUTH_SUPABASE_CLIENT_ID / OAUTH_SUPABASE_CLIENT_SECRET
   の登録が必要（トークン交換は /api/oauth/exchange が行う）。 */
const SUPABASE_CLIENT_ID = "46db16e8-735d-4e1d-92b2-10f37f8396af";

const API_BASE =
  typeof window !== "undefined" && window.location.hostname.endsWith("vercel.app")
    ? ""
    : "https://eluntra.vercel.app";

export interface OAuthService {
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  userInfoUrl?: string;
  /** client_id が判明しているか（Google系は判明済み、その他は未登録） */
  clientIdKnown: boolean;
  /** サービス固有の client_id（公開値）。未指定なら Google 系のものを使う */
  clientId?: string;
  /** 開発者画面で登録するときの注意 */
  note: string;
  extraAuthorizeParams?: Record<string, string>;
}

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MS_USERINFO = "https://graph.microsoft.com/v1.0/me";

export const OAUTH_SERVICES: Record<string, OAuthService> = {
  gdrive: {
    id: "gdrive", authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN, userInfoUrl: GOOGLE_USERINFO,
    scopes: "openid email https://www.googleapis.com/auth/drive.readonly", clientIdKnown: true,
    note: "Google Cloud側で、このアプリ用のOAuthクライアントにリダイレクトURIの追加登録と、シークレットのVercel環境変数への登録が必要です。",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  gcal: {
    id: "gcal", authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN, userInfoUrl: GOOGLE_USERINFO,
    scopes: "openid email https://www.googleapis.com/auth/calendar.readonly", clientIdKnown: true,
    note: "Google Cloud側で、このアプリ用のOAuthクライアントにリダイレクトURIの追加登録と、シークレットのVercel環境変数への登録が必要です。",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  gmail: {
    id: "gmail", authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN, userInfoUrl: GOOGLE_USERINFO,
    scopes: "openid email https://www.googleapis.com/auth/gmail.readonly", clientIdKnown: true,
    note: "Google Cloud側で、このアプリ用のOAuthクライアントにリダイレクトURIの追加登録と、シークレットのVercel環境変数への登録が必要です。Gmailは制限付きスコープのため、Googleの審査が別途必要になる場合があります。",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  gdocs: {
    id: "gdocs", authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN, userInfoUrl: GOOGLE_USERINFO,
    scopes: "openid email https://www.googleapis.com/auth/drive.readonly", clientIdKnown: true,
    note: "Google Cloud側で、このアプリ用のOAuthクライアントにリダイレクトURIの追加登録と、シークレットのVercel環境変数への登録が必要です。",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  gsheets: {
    id: "gsheets", authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN, userInfoUrl: GOOGLE_USERINFO,
    scopes: "openid email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly", clientIdKnown: true,
    note: "Google Cloud側で、このアプリ用のOAuthクライアントにリダイレクトURIの追加登録と、シークレットのVercel環境変数への登録が必要です。",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  youtube: {
    id: "youtube", authorizeUrl: GOOGLE_AUTH, tokenUrl: GOOGLE_TOKEN, userInfoUrl: GOOGLE_USERINFO,
    scopes: "openid email https://www.googleapis.com/auth/youtube.readonly", clientIdKnown: true,
    note: "Google Cloud側で、このアプリ用のOAuthクライアントにリダイレクトURIの追加登録と、シークレットのVercel環境変数への登録が必要です。",
    extraAuthorizeParams: { access_type: "offline", prompt: "consent" },
  },
  notion: {
    id: "notion", authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: "", clientIdKnown: false,
    note: "Notionのインテグレーション設定で OAuth を有効にし、リダイレクトURIとクライアント情報を登録する必要があります。トークン交換はNotion専用形式（Basic認証）です。",
    extraAuthorizeParams: { owner: "user" },
  },
  slack: {
    id: "slack", authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access", userInfoUrl: "https://slack.com/api/auth.test",
    scopes: "channels:read,users:read", clientIdKnown: false,
    note: "Slackアプリの OAuth & Permissions でリダイレクトURLとクライアント情報を登録する必要があります。",
  },
  discord: {
    id: "discord", authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token", userInfoUrl: "https://discord.com/api/users/@me",
    scopes: "identify", clientIdKnown: false,
    note: "Discord Developer Portal の OAuth2 でリダイレクトURIとクライアント情報を登録する必要があります。",
  },
  onedrive: {
    id: "onedrive", authorizeUrl: MS_AUTH, tokenUrl: MS_TOKEN, userInfoUrl: MS_USERINFO,
    scopes: "openid profile offline_access Files.Read", clientIdKnown: false,
    note: "Microsoft Entra（Azureポータル）のアプリ登録で、リダイレクトURIとクライアントシークレットの登録が必要です。",
  },
  outlook: {
    id: "outlook", authorizeUrl: MS_AUTH, tokenUrl: MS_TOKEN, userInfoUrl: MS_USERINFO,
    scopes: "openid profile offline_access Mail.Read Calendars.Read", clientIdKnown: false,
    note: "Microsoft Entra（Azureポータル）のアプリ登録で、リダイレクトURIとクライアントシークレットの登録が必要です。",
  },
  dropbox: {
    id: "dropbox", authorizeUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token", userInfoUrl: "https://api.dropboxapi.com/2/users/get_current_account",
    scopes: "account_info.read files.metadata.read", clientIdKnown: false,
    note: "Dropbox App Console の OAuth 2 設定でリダイレクトURIとクライアント情報を登録する必要があります。",
    extraAuthorizeParams: { token_access_type: "offline" },
  },
  linear: {
    id: "linear", authorizeUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: "read", clientIdKnown: false,
    note: "Linear の Settings → API → OAuth applications でリダイレクトURIとクライアント情報を登録する必要があります。",
  },
  trello: {
    id: "trello", authorizeUrl: "https://trello.com/1/authorize",
    tokenUrl: "", scopes: "read", clientIdKnown: false,
    note: "Trelloは認可コード方式ではなく、APIキー＋トークンを返す独自方式のため、この汎用エンジンとは別対応が必要です。",
  },
  jira: {
    id: "jira", authorizeUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token", userInfoUrl: "https://api.atlassian.com/me",
    scopes: "read:jira-work read:jira-user offline_access", clientIdKnown: false,
    note: "Atlassian Developer Console で OAuth 2.0 (3LO) アプリを作成し、コールバックURLとクライアント情報を登録する必要があります。",
    extraAuthorizeParams: { audience: "api.atlassian.com", prompt: "consent" },
  },
  /* Supabase Management API の OAuth 2.0。認可・トークン交換とも
     api.supabase.com 配下。アカウント確認専用エンドポイントは無いため、
     接続確認はプロジェクト一覧（GET /v1/projects）の成功で代替する
     （交換側 /api/oauth/exchange の SERVICES.supabase を参照）。
     リフレッシュトークンが発行される場合も、保存形式は他のサービスと
     同じくアクセストークン文字列とし、失効したら再接続する運用にする。 */
  supabase: {
    id: "supabase", authorizeUrl: "https://api.supabase.com/v1/oauth/authorize",
    tokenUrl: "https://api.supabase.com/v1/oauth/token",
    scopes: "projects:read projects:write", clientIdKnown: true, clientId: SUPABASE_CLIENT_ID,
    note: "「接続」を押すと Supabase のログイン画面に進み、承認すると繋がります。繋ぐと Management API（SQL実行・プロジェクト操作）がエージェントから使えるようになります。",
  },
};

/** 現時点で実際にOAuth接続まで進めるサービスか（サーバー側シークレット登録が前提。
    supabase は 2026-11-08 に OAuth アプリ登録と Vercel 環境変数登録が完了したため有効） */
export function oauthReady(id: string): boolean {
  return id === "supabase";
}

/* ---------- PKCE ---------- */

function randomString(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

async function sha256Base64Url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PENDING_KEY = "eluntra_oauth_pending";

interface PendingOAuth { service: string; state: string; verifier: string }

/** 認可画面への遷移を開始する（oauthReady なサービス専用。未準備のサービスではUI側で説明を出す） */
export async function startOAuth(id: string): Promise<void> {
  const svc = OAUTH_SERVICES[id];
  if (!svc) throw new Error("このサービスはOAuth設定がありません");
  const clientId = svc.clientIdKnown ? svc.clientId || GOOGLE_CLIENT_ID : "";
  if (!clientId) throw new Error("クライアント情報が未登録のため、まだ認可画面へ進めません");
  const state = randomString(24);
  const verifier = randomString(64);
  const challenge = await sha256Base64Url(verifier);
  const pending: PendingOAuth = { service: id, state, verifier };
  try {
    // sessionStorage だとタブやブラウザ文脈が変わると失われ、戻ってきた時に
    // state 不一致になるため localStorage に保存する（v6.5.2 の修正）
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch { /* ignore */ }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: svc.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(svc.extraAuthorizeParams || {}),
  });
  window.location.href = `${svc.authorizeUrl}?${params.toString()}`;
}

/** コールバック（?code=&state=）を検出してトークン交換する。処理したら true */
export async function handleOAuthCallback(): Promise<{ service: string; ok: boolean; msg: string } | null> {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return null;
  let pending: PendingOAuth | null = null;
  try {
    const raw = localStorage.getItem(PENDING_KEY) || sessionStorage.getItem(PENDING_KEY);
    if (raw) pending = JSON.parse(raw) as PendingOAuth;
  } catch { pending = null; }
  // URLからは常に除去する
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState(null, "", url.toString());
  if (!pending || pending.state !== stateParam) {
    // 従来URL（SUS）側で接続を始めた場合、コールバックは固定で Vercel 側に届くため
    // このオリジンには確認情報が無い。その場合はコードと state をそのまま従来URL側の
    // アプリへ引き継ぎ、始めた側でトークン交換を完了させる（確認情報は始めた側にだけある）。
    const fwd = new URL(window.location.href).searchParams.get("oauth_fwd");
    if (!fwd && window.location.origin === "https://eluntra.vercel.app") {
      const to = new URL("https://simple-url-server.lovable.app/s/eluntra/");
      to.searchParams.set("code", code);
      to.searchParams.set("state", stateParam);
      to.searchParams.set("oauth_fwd", "1");
      window.location.replace(to.toString());
      return { service: "", ok: false, msg: "接続の続きを、接続を始めたページで完了しています…" };
    }
    return { service: "", ok: false, msg: "接続の確認情報（state）が一致しませんでした。対処：接続ボタンを押したのと同じページ・同じブラウザで、もう一度「接続」からやり直してください" };
  }
  try { localStorage.removeItem(PENDING_KEY); sessionStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
  try {
    const res = await fetch(`${API_BASE}/api/oauth/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: pending.service,
        code,
        code_verifier: pending.verifier,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const j = (await res.json()) as { ok?: boolean; access_token?: string; account?: string; message?: string };
    if (j.ok && j.access_token) {
      const st = getState();
      update({
        connectors: { ...st.connectors, [pending.service]: j.access_token },
        connectorAccounts: { ...st.connectorAccounts, [pending.service]: j.account || "" },
      });
      return { service: pending.service, ok: true, msg: "接続しました" };
    }
    return { service: pending.service, ok: false, msg: j.message || "トークン交換に失敗しました" };
  } catch {
    return { service: pending.service, ok: false, msg: "トークン交換サーバーへ通信できませんでした" };
  }
}

/* ---------- GitHub デバイスフロー ---------- */

export interface DeviceStartResult {
  ok: boolean;
  /** ok=false かつ GitHubアプリ側で未有効化のとき true */
  disabled?: boolean;
  userCode?: string;
  verificationUri?: string;
  deviceCode?: string;
  interval?: number;
  message?: string;
}

export async function githubDeviceStart(): Promise<DeviceStartResult> {
  try {
    const res = await fetch(`${API_BASE}/api/oauth/github-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "device_code" }),
    });
    const j = (await res.json()) as {
      device_code?: string; user_code?: string; verification_uri?: string; interval?: number;
      error?: string; error_description?: string;
    };
    if (j.device_code && j.user_code) {
      return {
        ok: true,
        userCode: j.user_code,
        verificationUri: j.verification_uri || "https://github.com/login/device",
        deviceCode: j.device_code,
        interval: Math.max(5, j.interval || 5),
      };
    }
    if (j.error === "device_flow_disabled") {
      return { ok: false, disabled: true, message: j.error_description || "Device Flow must be explicitly enabled for this App" };
    }
    return { ok: false, message: j.error_description || j.error || "GitHubがエラーを返しました" };
  } catch {
    return { ok: false, message: "中継サーバーへ通信できませんでした。電波を確認してください" };
  }
}

export type DevicePollResult =
  | { status: "authorized"; token: string; account: string }
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "error"; message: string };

export async function githubDevicePoll(deviceCode: string): Promise<DevicePollResult> {
  try {
    const res = await fetch(`${API_BASE}/api/oauth/github-device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "poll", device_code: deviceCode }),
    });
    const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (j.access_token) {
      let account = "";
      try {
        const me = await fetch("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${j.access_token}`, Accept: "application/vnd.github+json" },
        });
        if (me.ok) {
          const u = (await me.json()) as { login?: string };
          account = u.login ? `@${u.login}` : "";
        }
      } catch { /* アカウント名が取れなくても接続自体は成立 */ }
      return { status: "authorized", token: j.access_token, account };
    }
    if (j.error === "authorization_pending") return { status: "pending" };
    if (j.error === "slow_down") return { status: "slow_down" };
    return { status: "error", message: j.error_description || j.error || "認可が完了しませんでした" };
  } catch {
    return { status: "error", message: "通信できませんでした" };
  }
}

/** 取得したGitHubトークンを保存する（従来のコネクタ保存と同一枠） */
export function saveConnectorToken(id: string, token: string, account: string): void {
  const st = getState();
  update({
    connectors: { ...st.connectors, [id]: token },
    connectorAccounts: { ...st.connectorAccounts, [id]: account },
  });
}

export function disconnectConnector(id: string): void {
  const st = getState();
  const connectors = { ...st.connectors };
  delete connectors[id];
  const accounts = { ...st.connectorAccounts };
  delete accounts[id];
  update({ connectors, connectorAccounts: accounts });
}
