import { getState, readJSON, update, writeJSON } from "./store";
import type { ChatSession, Note } from "./types";

/**
 * Supabase Auth（共用プロジェクト）によるログインとクラウド同期（新規実装）。
 * 同期対象は会話・設定・メモ・コードのみ。APIキーは端末外に出さない。
 * 取り込みは「置き換え」ではなく会話IDで統合する（片方だけにある会話を消さない）。
 */

const SUPABASE_URL = "https://rzgldbedsjocmvqrfdhf.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6Z2xkYmVkc2pvY212cXJmZGhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM0NzMzMzAsImV4cCI6MjEwOTA0OTMzMH0.3y77je51HEUxAV4E1yYN7UU3Cxgnrr7Elt2ingRwVsw";

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
const PKCE_LS = "eluntra_pkce_verifier";

let session: StoredSession | null = (() => {
  try {
    const raw = localStorage.getItem(AUTH_LS);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
})();

const listeners = new Set<() => void>();
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
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

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SUPABASE_ANON_KEY, ...extra };
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function loginWith(provider: OAuthProvider): Promise<void> {
  const redirectTo = location.href.split("#")[0].split("?")[0];
  let url = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${encodeURIComponent(redirectTo)}`;
  // ブラウザに残っているプロバイダ側セッションを黙って再利用させず、アカウント選択を出す。
  // GoTrue は prompt をプロバイダの認可URLへそのまま転送する（github / google で実測済み）。
  if (provider === "github" || provider === "google") {
    url += `&prompt=select_account`;
  }
  try {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = b64url(new Uint8Array(digest));
    sessionStorage.setItem(PKCE_LS, verifier);
    url += `&code_challenge=${challenge}&code_challenge_method=s256`;
  } catch {
    /* PKCEが使えない環境では暗黙フローに任せる */
  }
  location.href = url;
}

interface SupaUser {
  id: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

function toUser(u: SupaUser): AuthUser {
  const meta = u.user_metadata || {};
  return {
    id: u.id,
    email: u.email || (meta.email as string) || "",
    name: (meta.user_name as string) || (meta.full_name as string) || (meta.name as string) || "",
    avatarUrl: (meta.avatar_url as string) || (meta.picture as string) || "",
    provider: (u.app_metadata?.provider as string) || "",
  };
}

export async function handleAuthCallback(): Promise<{ handled: boolean; error?: string }> {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  if (code) {
    history.replaceState(null, "", location.pathname);
    const verifier = sessionStorage.getItem(PKCE_LS);
    sessionStorage.removeItem(PKCE_LS);
    if (!verifier) return { handled: true, error: "ログインの検証情報が見つかりませんでした。もう一度ログインしてください" };
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ auth_code: code, code_verifier: verifier }),
      });
      if (!res.ok) throw new Error("pkce failed");
      const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; user: SupaUser };
      storeSession({
        accessToken: j.access_token,
        refreshToken: j.refresh_token,
        expiresAt: Date.now() + j.expires_in * 1000,
        user: toUser(j.user),
      });
      return { handled: true };
    } catch {
      return { handled: true, error: "ログイン処理に失敗しました。もう一度お試しください" };
    }
  }
  if (location.hash.includes("access_token")) {
    const params = new URLSearchParams(location.hash.slice(1));
    const accessToken = params.get("access_token") || "";
    const refreshToken = params.get("refresh_token") || "";
    const expiresIn = Number(params.get("expires_in") || 3600);
    history.replaceState(null, "", location.pathname + location.search);
    if (!accessToken) return { handled: true, error: "ログイン情報を取得できませんでした" };
    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: headers({ Authorization: `Bearer ${accessToken}` }),
      });
      if (!res.ok) throw new Error("user failed");
      const user = toUser((await res.json()) as SupaUser);
      storeSession({ accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000, user });
      return { handled: true };
    } catch {
      return { handled: true, error: "ログイン処理に失敗しました。もう一度お試しください" };
    }
  }
  if (location.hash.includes("error")) {
    const params = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname + location.search);
    return { handled: true, error: decodeURIComponent(params.get("error_description") || "ログインに失敗しました") };
  }
  return { handled: false };
}

async function ensureFresh(): Promise<boolean> {
  if (!session) return false;
  if (session.expiresAt - Date.now() > 120000) return true;
  if (!session.refreshToken) {
    storeSession(null);
    return false;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) throw new Error("refresh failed");
    const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; user: SupaUser };
    storeSession({
      accessToken: j.access_token,
      refreshToken: j.refresh_token,
      expiresAt: Date.now() + j.expires_in * 1000,
      user: toUser(j.user),
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
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: "POST",
        headers: headers({ Authorization: `Bearer ${session.accessToken}` }),
      });
    } catch {
      /* ローカル消去は必ず行う */
    }
  }
  storeSession(null);
  // アカウント切替時に前のアカウントの痕跡を残さない：
  // PKCE検証子（未完了ログイン）と同期の最終時刻（別アカウントの取り込み判定に使う）も消す。
  try {
    sessionStorage.removeItem(PKCE_LS);
    localStorage.removeItem(SYNC_LS);
  } catch {
    /* ignore */
  }
}

/* ---------- クラウド同期 ---------- */

interface SyncData {
  version: 1;
  sessions: ChatSession[];
  conf: { provider: string; models: Record<string, string>; system: string; temp: number; agent?: boolean };
  notes?: Note[];
  code?: string;
  codes?: Record<string, string>;
}

function collect(): SyncData {
  const st = getState();
  const codes = readJSON<Record<string, string>>("eluntra_codes", {});
  return {
    version: 1,
    sessions: st.sessions,
    conf: {
      provider: st.conf.provider,
      models: st.conf.models,
      system: st.conf.system,
      temp: st.conf.temp,
      agent: st.conf.agent,
    },
    notes: st.notes,
    code: codes.html || readJSON<string>("eluntra_code", ""),
    codes,
  };
}

function apply(data: SyncData): void {
  const st = getState();
  if (Array.isArray(data.sessions)) {
    const byId = new Map<string, ChatSession>();
    data.sessions.forEach((s) => {
      if (s?.id) byId.set(s.id, s);
    });
    st.sessions.forEach((s) => {
      if (!s?.id) return;
      const c = byId.get(s.id);
      if (!c || (s.messages?.length ?? 0) > (c.messages?.length ?? 0)) byId.set(s.id, s);
    });
    const merged = [...byId.values()].sort((a, b) => (b.created || 0) - (a.created || 0));
    update({ sessions: merged });
    if (!merged.find((x) => x.id === getState().currentId)) {
      update({ currentId: merged.length ? merged[0].id : null });
    }
  }
  if (data.conf) {
    const conf = { ...getState().conf };
    conf.provider = data.conf.provider || conf.provider;
    conf.models = { ...conf.models, ...(data.conf.models || {}) };
    conf.system = data.conf.system || "";
    if (typeof data.conf.temp === "number") conf.temp = data.conf.temp;
    if (typeof data.conf.agent === "boolean") conf.agent = data.conf.agent;
    update({ conf });
  }
  if (Array.isArray(data.notes)) {
    const byId = new Map<string, Note>();
    data.notes.forEach((n) => {
      if (n?.id) byId.set(n.id, n);
    });
    getState().notes.forEach((n) => {
      if (n?.id && !byId.has(n.id)) byId.set(n.id, n);
    });
    update({ notes: [...byId.values()] });
  }
  if (data.codes && typeof data.codes === "object") {
    writeJSON("eluntra_codes", data.codes);
    if (typeof data.codes.html === "string") writeJSON("eluntra_code", data.codes.html);
    update({ codes: data.codes });
  } else if (typeof data.code === "string" && data.code) {
    writeJSON("eluntra_code", data.code);
  }
}

async function syncHeaders(): Promise<Record<string, string> | null> {
  if (!(await ensureFresh()) || !session) return null;
  return headers({ Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" });
}

export async function pushSync(): Promise<boolean> {
  const h = await syncHeaders();
  if (!h || !session) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/eluntra_sync`, {
      method: "POST",
      headers: { ...h, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: session.user.id, data: collect(), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return false;
    setLastSyncAt(Date.now());
    return true;
  } catch {
    return false;
  }
}

export async function pullSync(): Promise<"applied" | "exists" | "none"> {
  const h = await syncHeaders();
  if (!h || !session) return "none";
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/eluntra_sync?select=data,updated_at&user_id=eq.${session.user.id}`,
      { headers: h },
    );
    if (!res.ok) return "none";
    const rows = (await res.json()) as Array<{ data: SyncData; updated_at: string }>;
    if (!rows.length) return "none";
    const cloudTime = new Date(rows[0].updated_at).getTime();
    if (cloudTime > lastSyncAt() + 1000) {
      apply(rows[0].data);
      setLastSyncAt(cloudTime);
      return "applied";
    }
    return "exists";
  } catch {
    return "none";
  }
}
