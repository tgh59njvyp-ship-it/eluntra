import { persistConf, persistSessions, state } from "./state";
import type { Session } from "./types";

/**
 * Supabase Auth（共用プロジェクト）を使ったログインとクラウド同期。
 * - ログイン: GitHub / Google / Apple（Supabaseの /auth/v1/authorize へ遷移するOAuth）
 * - 同期対象: 会話と設定のみ。APIキーは端末外に出さないため同期しない。
 */

export const AUTH_URL = "https://rzgldbedsjocmvqrfdhf.supabase.co";
export const AUTH_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6Z2xkYmVkc2pvY212cXJmZGhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NzMzMzAsImV4cCI6MjEwOTA0OTMzMH0.3y77je51HEUxAV4E1yYN7UU3Cxgnrr7Elt2ingRwVsw";

export type OAuthProvider = "github" | "google" | "apple";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
  provider: string;
}

interface StoredSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

const AUTH_LS = "eluntra_auth";
const SYNC_LS = "eluntra_last_sync";

let session: StoredSession | null = (() => {
  try {
    const raw = localStorage.getItem(AUTH_LS);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
})();

type Listener = () => void;
const listeners = new Set<Listener>();
export function onAuthChange(fn: Listener): void {
  listeners.add(fn);
}
function notify(): void {
  listeners.forEach((fn) => fn());
}

export function currentUser(): AuthUser | null {
  return session?.user ?? null;
}
export function isLoggedIn(): boolean {
  return !!session;
}
export function lastSyncAt(): number {
  const v = Number(localStorage.getItem(SYNC_LS) || 0);
  return Number.isFinite(v) ? v : 0;
}
function setLastSyncAt(t: number): void {
  try {
    localStorage.setItem(SYNC_LS, String(t));
  } catch {
    /* ignore */
  }
}

function storeSession(s: StoredSession | null): void {
  session = s;
  try {
    if (s) localStorage.setItem(AUTH_LS, JSON.stringify(s));
    else localStorage.removeItem(AUTH_LS);
  } catch {
    /* ignore */
  }
  notify();
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: AUTH_KEY, ...extra };
}

function base64Url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE_LS = "eluntra_pkce_verifier";

/** OAuth開始：PKCEでSupabaseの認可エンドポイントへ遷移する */
export async function loginWith(provider: OAuthProvider): Promise<void> {
  const redirectTo = location.href.split("#")[0].split("?")[0];
  let url =
    `${AUTH_URL}/auth/v1/authorize?provider=${provider}` +
    `&redirect_to=${encodeURIComponent(redirectTo)}`;
  try {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = base64Url(new Uint8Array(digest));
    sessionStorage.setItem(PKCE_LS, verifier);
    url += `&code_challenge=${challenge}&code_challenge_method=s256`;
  } catch {
    /* PKCEが組めない環境では暗黙フローにフォールバック */
  }
  location.href = url;
}

interface SupabaseUserPayload {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

function toAuthUser(u: SupabaseUserPayload): AuthUser {
  const meta = u.user_metadata || {};
  const name =
    (meta.user_name as string) ||
    (meta.full_name as string) ||
    (meta.name as string) ||
    "";
  return {
    id: u.id,
    email: u.email || (meta.email as string) || "",
    name,
    avatarUrl: (meta.avatar_url as string) || (meta.picture as string) || "",
    provider: (u.app_metadata?.provider as string) || "",
  };
}

async function fetchUser(accessToken: string): Promise<AuthUser> {
  const res = await fetch(`${AUTH_URL}/auth/v1/user`, {
    headers: authHeaders({ Authorization: `Bearer ${accessToken}` }),
  });
  if (!res.ok) throw new Error("ユーザー情報の取得に失敗しました");
  return toAuthUser((await res.json()) as SupabaseUserPayload);
}

export interface CallbackResult {
  handled: boolean;
  error?: string;
}

/** リダイレクト戻り（PKCEの ?code= / 暗黙フローの #access_token=）の処理。起動時に1回呼ぶ */
export async function handleAuthCallback(): Promise<CallbackResult> {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  if (code) {
    history.replaceState(null, "", location.pathname);
    const verifier = sessionStorage.getItem(PKCE_LS);
    sessionStorage.removeItem(PKCE_LS);
    if (!verifier) {
      return { handled: true, error: "ログインの検証情報が見つかりませんでした。もう一度ログインしてください" };
    }
    try {
      const res = await fetch(`${AUTH_URL}/auth/v1/token?grant_type=pkce`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      });
      if (!res.ok) throw new Error("pkce exchange failed");
      const j = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        user: SupabaseUserPayload;
      };
      storeSession({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: Date.now() + j.expires_in * 1000,
        user: toAuthUser(j.user),
      });
      return { handled: true };
    } catch {
      return { handled: true, error: "ログイン処理に失敗しました。もう一度お試しください" };
    }
  }
  if (!location.hash || !location.hash.includes("access_token")) {
    if (location.hash && location.hash.includes("error")) {
      const params = new URLSearchParams(location.hash.slice(1));
      history.replaceState(null, "", location.pathname + location.search);
      return {
        handled: true,
        error: decodeURIComponent(params.get("error_description") || "ログインに失敗しました"),
      };
    }
    return { handled: false };
  }
  const params = new URLSearchParams(location.hash.slice(1));
  const accessToken = params.get("access_token") || "";
  const refreshToken = params.get("refresh_token") || "";
  const expiresIn = Number(params.get("expires_in") || 3600);
  history.replaceState(null, "", location.pathname + location.search);
  if (!accessToken) return { handled: true, error: "ログイン情報を取得できませんでした" };
  try {
    const user = await fetchUser(accessToken);
    storeSession({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      user,
    });
    return { handled: true };
  } catch {
    return { handled: true, error: "ログイン処理に失敗しました。もう一度お試しください" };
  }
}

/** 期限が近ければリフレッシュする。失敗したらログアウト状態にする */
export async function ensureFreshSession(): Promise<boolean> {
  if (!session) return false;
  if (session.expiresAt - Date.now() > 120000) return true;
  if (!session.refreshToken) {
    storeSession(null);
    return false;
  }
  try {
    const res = await fetch(`${AUTH_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) throw new Error("refresh failed");
    const j = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user: SupabaseUserPayload;
    };
    storeSession({
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + j.expires_in * 1000,
      user: toAuthUser(j.user),
    });
    return true;
  } catch {
    storeSession(null);
    return false;
  }
}

export async function logout(): Promise<void> {
  if (session) {
    try {
      await fetch(`${AUTH_URL}/auth/v1/logout`, {
        method: "POST",
        headers: authHeaders({ Authorization: `Bearer ${session.accessToken}` }),
      });
    } catch {
      /* ローカル側の消去は必ず行う */
    }
  }
  storeSession(null);
}

/* ---------- クラウド同期（eluntra_sync テーブル、自分の行だけRLSで許可） ---------- */

interface SyncData {
  version: 1;
  sessions: Session[];
  conf: { provider: string; models: Record<string, string>; system: string; temp: number };
}

function collectSyncData(): SyncData {
  return {
    version: 1,
    sessions: state.sessions,
    conf: {
      provider: state.conf.provider,
      models: state.conf.models,
      system: state.conf.system,
      temp: state.conf.temp,
    },
  };
}

function applySyncData(data: SyncData): void {
  if (Array.isArray(data.sessions)) {
    state.sessions = data.sessions;
    state.currentId = state.sessions.length ? state.sessions[0].id : null;
    persistSessions();
  }
  if (data.conf) {
    state.conf.provider = data.conf.provider || state.conf.provider;
    state.conf.models = { ...state.conf.models, ...(data.conf.models || {}) };
    state.conf.system = data.conf.system || "";
    state.conf.temp = typeof data.conf.temp === "number" ? data.conf.temp : state.conf.temp;
    persistConf();
  }
}

async function syncHeaders(): Promise<Record<string, string> | null> {
  if (!(await ensureFreshSession()) || !session) return null;
  return authHeaders({
    Authorization: `Bearer ${session.accessToken}`,
    "Content-Type": "application/json",
  });
}

/** クラウドへ保存（upsert）。未ログイン・失敗時は false */
export async function pushSync(): Promise<boolean> {
  const headers = await syncHeaders();
  if (!headers || !session) return false;
  try {
    const res = await fetch(`${AUTH_URL}/rest/v1/eluntra_sync`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: session.user.id,
        data: collectSyncData(),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) return false;
    setLastSyncAt(Date.now());
    return true;
  } catch {
    return false;
  }
}

/**
 * クラウドから取得。クラウド側が前回同期より新しければ取り込む。
 * applied: 取り込んだ / exists: データはあるが新しいものはない / none: まだ何もない
 */
export async function pullSync(): Promise<"applied" | "exists" | "none"> {
  const headers = await syncHeaders();
  if (!headers || !session) return "none";
  try {
    const res = await fetch(
      `${AUTH_URL}/rest/v1/eluntra_sync?select=data,updated_at&user_id=eq.${session.user.id}`,
      { headers },
    );
    if (!res.ok) return "none";
    const rows = (await res.json()) as Array<{ data: SyncData; updated_at: string }>;
    if (!rows.length) return "none";
    const cloudTime = new Date(rows[0].updated_at).getTime();
    if (cloudTime > lastSyncAt() + 1000) {
      applySyncData(rows[0].data);
      setLastSyncAt(cloudTime);
      return "applied";
    }
    return "exists";
  } catch {
    return "none";
  }
}

/* ---------- ブランドアイコン（ログイン用） ---------- */

export const BRAND_ICONS: Record<OAuthProvider, string> = {
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>',
  google: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"/></svg>',
  apple: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg>',
};
