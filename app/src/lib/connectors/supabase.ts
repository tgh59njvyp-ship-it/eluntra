import { CUSTOM_PROXY_URL } from "../providers/transport";
import { getState } from "../store";

/**
 * Supabaseコネクタ（17種目）。
 *
 * 接続方法は2通り：
 *  a) ログイン式（OAuth）：Supabase の Management API OAuth。アプリ登録が済むまで
 *     「準備中」（lib/connectors/oauth.ts の OAUTH_SERVICES.supabase）。
 *     取得したアクセストークンは connectors["supabase"] に文字列として保存される。
 *  b) トークン式（上級者向け）：プロジェクトURL＋サービスロールキー（＋任意で
 *     アクセストークン sbp_）を JSON 文字列として connectors["supabase"] に保存する。
 *
 * いずれも端末に保存され、ログイン中は他のコネクタと同様に本人のアカウント
 * （eluntra_sync）へ同期される（v6.8〜）。
 * サービスロールキーはフルアクセス権限を持つため、画面表示・エージェントの
 * ツール結果には絶対に含めない。
 */

export interface SupabaseCreds {
  /** プロジェクトURL（https://<ref>.supabase.co） */
  url: string;
  /** サービスロールキー（DB REST＋Auth管理に使う） */
  serviceKey: string;
  /** アクセストークン sbp_…（Management API＝SQL実行に使う） */
  sbp: string;
  /** ログイン式接続のアクセストークン */
  oauthToken: string;
}

export const SUPABASE_NOT_CONNECTED =
  "Supabaseコネクタが未接続です。設定の「コネクタ」からSupabaseを接続してください（プロジェクトURL＋サービスロールキー、またはアクセストークン sbp_）。";

/** 保存済みの接続情報を読む。未接続なら null */
export function supabaseCreds(): SupabaseCreds | null {
  const raw = (getState().connectors["supabase"] || "").trim();
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Partial<SupabaseCreds>;
      const c: SupabaseCreds = {
        url: (j.url || "").trim().replace(/\/+$/, ""),
        serviceKey: (j.serviceKey || "").trim(),
        sbp: (j.sbp || "").trim(),
        oauthToken: "",
      };
      return c.url || c.serviceKey || c.sbp ? c : null;
    } catch {
      return null;
    }
  }
  /* ログイン式（OAuth）で保存されたアクセストークン */
  return { url: "", serviceKey: "", sbp: "", oauthToken: raw };
}

export function supabaseConnected(): boolean {
  return supabaseCreds() !== null;
}

/** プロジェクトURLからプロジェクトrefを取り出す */
export function projectRefOf(c: SupabaseCreds): string {
  const m = c.url.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co/i);
  return m ? m[1] : "";
}

/** Management API に使えるトークン（sbp_ 優先、なければOAuthトークン） */
function mgmtToken(c: SupabaseCreds): string {
  return c.sbp || c.oauthToken;
}

function hasRest(c: SupabaseCreds): boolean {
  return !!(c.url && c.serviceKey);
}

/**
 * Supabase の API は CORS 対応のため基本は直接 fetch する。
 * ネットワーク層で失敗（TypeError＝CORS遮断など）した場合のみ、
 * カスタムプロバイダー用中継（/api/custom-proxy）経由で1回だけ再試行する。
 * ※中継は GET/POST のみ・転送ヘッダー制限があるため、再試行はベストエフォート。
 */
async function sbFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (e instanceof TypeError) {
      const headers = new Headers(init.headers);
      headers.set("x-target-url", url);
      return fetch(CUSTOM_PROXY_URL, { ...init, headers });
    }
    throw e;
  }
}

function cap(s: string, n = 4000): string {
  return s.length > n ? `${s.slice(0, n)}\n…（長いため省略しました。全${s.length}文字）` : s;
}

function restHeaders(c: SupabaseCreds, extra?: Record<string, string>): Record<string, string> {
  return {
    apikey: c.serviceKey,
    Authorization: `Bearer ${c.serviceKey}`,
    "Content-Type": "application/json",
    ...(extra || {}),
  };
}

/* ---------- 接続テスト ---------- */

export async function testSupabaseConnection(): Promise<{ ok: boolean; msg: string }> {
  const c = supabaseCreds();
  if (!c) return { ok: false, msg: "接続情報が未入力です" };
  try {
    if (hasRest(c)) {
      const res = await sbFetch(`${c.url}/rest/v1/`, { headers: restHeaders(c) });
      if (res.ok) return { ok: true, msg: "接続できました（データベースREST）" };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, msg: "サービスロールキーが正しくないか、権限がありません。Supabaseの Settings → API でキーを確認してください" };
      }
      return { ok: false, msg: `Supabaseが ${res.status} を返しました。プロジェクトURLを確認してください` };
    }
    const tok = mgmtToken(c);
    if (tok) {
      const res = await sbFetch("https://api.supabase.com/v1/projects", {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.ok) return { ok: true, msg: "接続できました（Management API）" };
      return { ok: false, msg: `Supabase Management APIが ${res.status} を返しました。アクセストークンを確認してください` };
    }
    return { ok: false, msg: "プロジェクトURL＋サービスロールキー、またはアクセストークンを入力してください" };
  } catch {
    return { ok: false, msg: "通信できませんでした。電波とプロジェクトURLを確認してください" };
  }
}

/* ---------- Management API（SQL） ---------- */

interface MgmtProject { id?: string; ref?: string; name?: string }

async function listProjects(c: SupabaseCreds): Promise<MgmtProject[]> {
  const tok = mgmtToken(c);
  if (!tok) return [];
  const res = await sbFetch("https://api.supabase.com/v1/projects", {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) return [];
  const j = (await res.json()) as MgmtProject[];
  return Array.isArray(j) ? j : [];
}

/** SQLに使うプロジェクトrefを解決する（URL優先、なければプロジェクト一覧の先頭） */
async function resolveRef(c: SupabaseCreds): Promise<string> {
  const fromUrl = projectRefOf(c);
  if (fromUrl) return fromUrl;
  const projects = await listProjects(c);
  const p = projects[0];
  return (p && (p.ref || p.id)) || "";
}

async function runSql(c: SupabaseCreds, query: string): Promise<unknown> {
  const tok = mgmtToken(c);
  if (!tok) throw new Error("SQLの実行にはアクセストークン（sbp_）またはログイン式接続が必要です");
  const ref = await resolveRef(c);
  if (!ref) throw new Error("プロジェクトが特定できませんでした。プロジェクトURLも入力してください");
  const res = await sbFetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQLエラー（${res.status}）: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/* ---------- エージェント用ツール ---------- */

function requireCreds(): SupabaseCreds {
  const c = supabaseCreds();
  if (!c) throw new Error(SUPABASE_NOT_CONNECTED);
  return c;
}

function requireRest(c: SupabaseCreds): void {
  if (!hasRest(c)) {
    throw new Error("この操作にはプロジェクトURL＋サービスロールキーが必要です。設定の「コネクタ」→ Supabase の「トークンで接続（上級者向け）」で入力してください");
  }
}

/** テーブル名として安全な文字だけを許可する（SQL経路の組み立て用） */
function safeIdent(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`テーブル名が不正です: ${name}`);
  return name;
}

/** "列名=値" 形式のフィルタを分解する */
function parseFilter(filter: string): { col: string; value: string } {
  const i = filter.indexOf("=");
  if (i <= 0) throw new Error("filter は「列名=値」の形式で指定してください");
  return { col: filter.slice(0, i).trim(), value: filter.slice(i + 1) };
}

export async function supabaseTables(): Promise<string> {
  const c = requireCreds();
  if (hasRest(c)) {
    const res = await sbFetch(`${c.url}/rest/v1/`, { headers: restHeaders(c) });
    if (!res.ok) return `テーブル一覧の取得に失敗しました（${res.status}）`;
    const j = (await res.json()) as { definitions?: Record<string, unknown>; paths?: Record<string, unknown> };
    const fromDefs = Object.keys(j.definitions || {});
    const names = fromDefs.length
      ? fromDefs
      : Object.keys(j.paths || {}).map((p) => p.replace(/^\//, "")).filter(Boolean);
    return names.length ? `テーブル一覧（${names.length}件）:\n${names.map((n) => `- ${n}`).join("\n")}` : "テーブルが見つかりませんでした";
  }
  const rows = (await runSql(
    c,
    "select table_name from information_schema.tables where table_schema='public' order by 1",
  )) as Array<{ table_name?: string }>;
  const names = (rows || []).map((r) => r.table_name).filter(Boolean);
  return names.length ? `テーブル一覧（${names.length}件）:\n${names.map((n) => `- ${n}`).join("\n")}` : "テーブルが見つかりませんでした";
}

export async function supabaseSelect(args: { table?: string; limit?: string; filter?: string }): Promise<string> {
  const c = requireCreds();
  const table = (args.table || "").trim();
  if (!table) return "table を指定してください";
  const limit = Math.min(50, Math.max(1, Number.parseInt(args.limit || "20", 10) || 20));
  if (hasRest(c)) {
    let url = `${c.url}/rest/v1/${encodeURIComponent(table)}?select=*&limit=${limit}`;
    if (args.filter) {
      const f = parseFilter(args.filter);
      url += `&${encodeURIComponent(f.col)}=eq.${encodeURIComponent(f.value)}`;
    }
    const res = await sbFetch(url, { headers: restHeaders(c) });
    const text = await res.text();
    if (!res.ok) return `読み取りに失敗しました（${res.status}）: ${text.slice(0, 300)}`;
    return cap(`${table} の行（最大${limit}件）:\n${text}`);
  }
  const t = safeIdent(table);
  let q = `select * from public."${t}"`;
  if (args.filter) {
    const f = parseFilter(args.filter);
    q += ` where "${safeIdent(f.col)}" = '${f.value.replace(/'/g, "''")}'`;
  }
  q += ` limit ${limit}`;
  const rows = await runSql(c, q);
  return cap(`${table} の行（最大${limit}件）:\n${JSON.stringify(rows, null, 1)}`);
}

export async function supabaseInsert(args: { table?: string; row?: string }): Promise<string> {
  const c = requireCreds();
  requireRest(c);
  const table = (args.table || "").trim();
  if (!table) return "table を指定してください";
  let row: unknown;
  try {
    row = JSON.parse(args.row || "");
  } catch {
    return "row はJSON文字列で指定してください（例： {\"name\":\"x\"}）";
  }
  const res = await sbFetch(`${c.url}/rest/v1/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: restHeaders(c, { Prefer: "return=representation" }),
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) return `追加に失敗しました（${res.status}）: ${text.slice(0, 300)}`;
  return cap(`追加しました:\n${text}`);
}

export async function supabaseUpdate(args: { table?: string; filter?: string; values?: string }): Promise<string> {
  const c = requireCreds();
  requireRest(c);
  const table = (args.table || "").trim();
  if (!table) return "table を指定してください";
  if (!args.filter) return "安全のため、filter（列名=値）が必須です。全件更新はできません";
  let values: unknown;
  try {
    values = JSON.parse(args.values || "");
  } catch {
    return "values はJSON文字列で指定してください";
  }
  const f = parseFilter(args.filter);
  const url = `${c.url}/rest/v1/${encodeURIComponent(table)}?${encodeURIComponent(f.col)}=eq.${encodeURIComponent(f.value)}`;
  const res = await sbFetch(url, {
    method: "PATCH",
    headers: restHeaders(c, { Prefer: "return=representation" }),
    body: JSON.stringify(values),
  });
  const text = await res.text();
  if (!res.ok) return `更新に失敗しました（${res.status}）: ${text.slice(0, 300)}`;
  return cap(`更新しました:\n${text}`);
}

export async function supabaseDelete(args: { table?: string; filter?: string }): Promise<string> {
  const c = requireCreds();
  requireRest(c);
  const table = (args.table || "").trim();
  if (!table) return "table を指定してください";
  if (!args.filter) return "安全のため、filter（列名=値）が必須です。全件削除はできません";
  const f = parseFilter(args.filter);
  const url = `${c.url}/rest/v1/${encodeURIComponent(table)}?${encodeURIComponent(f.col)}=eq.${encodeURIComponent(f.value)}`;
  const res = await sbFetch(url, {
    method: "DELETE",
    headers: restHeaders(c, { Prefer: "return=representation" }),
  });
  const text = await res.text();
  if (!res.ok) return `削除に失敗しました（${res.status}）: ${text.slice(0, 300)}`;
  return cap(`削除しました:\n${text || "（削除対象の返却なし）"}`);
}

export async function supabaseSql(args: { query?: string }): Promise<string> {
  const c = requireCreds();
  const query = (args.query || "").trim();
  if (!query) return "query を指定してください";
  const rows = await runSql(c, query);
  if (Array.isArray(rows)) {
    return cap(`SQL結果（${rows.length}行）:\n${JSON.stringify(rows, null, 1)}`);
  }
  return cap(`SQL結果:\n${typeof rows === "string" ? rows : JSON.stringify(rows, null, 1)}`);
}

interface AuthUser {
  id?: string;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string;
}

export async function supabaseAuthUsers(args: {
  action?: string;
  email?: string;
  password?: string;
  userId?: string;
}): Promise<string> {
  const c = requireCreds();
  requireRest(c);
  const action = (args.action || "list").trim();
  const base = `${c.url}/auth/v1/admin/users`;
  if (action === "list") {
    const res = await sbFetch(base, { headers: restHeaders(c) });
    const text = await res.text();
    if (!res.ok) return `ユーザー一覧の取得に失敗しました（${res.status}）: ${text.slice(0, 300)}`;
    const j = JSON.parse(text) as { users?: AuthUser[] };
    const users = j.users || [];
    if (!users.length) return "登録ユーザーはまだいません";
    return cap(
      `登録ユーザー（${users.length}件）:\n` +
        users.map((u) => `- ${u.email || "(メールなし)"}（ID: ${u.id || "?"}、登録: ${u.created_at || "?"}、最終ログイン: ${u.last_sign_in_at || "なし"}）`).join("\n"),
    );
  }
  if (action === "create") {
    if (!args.email || !args.password) return "create には email と password が必要です";
    const res = await sbFetch(base, {
      method: "POST",
      headers: restHeaders(c),
      body: JSON.stringify({ email: args.email, password: args.password, email_confirm: true }),
    });
    const text = await res.text();
    if (!res.ok) return `ユーザー作成に失敗しました（${res.status}）: ${text.slice(0, 300)}`;
    const u = JSON.parse(text) as AuthUser;
    return `ユーザーを作成しました: ${u.email || args.email}（ID: ${u.id || "?"}）`;
  }
  if (action === "delete") {
    if (!args.userId) return "delete には userId が必要です";
    const res = await sbFetch(`${base}/${encodeURIComponent(args.userId)}`, {
      method: "DELETE",
      headers: restHeaders(c),
    });
    if (!res.ok) return `ユーザー削除に失敗しました（${res.status}）`;
    return "ユーザーを削除しました";
  }
  return "action は list / create / delete のいずれかを指定してください";
}
