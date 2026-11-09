import { CUSTOM_PROXY_URL } from "../providers/transport";
import { getState, update } from "../store";

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
        /* AIが作成したプロジェクトへ接続し直した際、Management APIトークンを失わないよう保持する */
        oauthToken: (j.oauthToken || "").trim(),
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

/* ---------- Management API（組織・プロジェクト作成） ---------- */

const MGMT_BASE = "https://api.supabase.com/v1";

export const SUPABASE_NO_MGMT_TOKEN =
  "プロジェクトの作成・確認には Management API のトークンが必要です。設定の「コネクタ」→ Supabase で、アクセストークン（sbp_）を入力するか、ログイン式で接続してください。";

/** Management API トークン（sbp_ またはログイン式）がある接続情報を返す。無ければ案内文で例外 */
function requireMgmtCreds(): SupabaseCreds {
  const c = supabaseCreds();
  if (!c || !mgmtToken(c)) throw new Error(SUPABASE_NO_MGMT_TOKEN);
  return c;
}

/** Management API を呼んで JSON を返す。エラー時は Supabase のメッセージをそのまま含める */
async function mgmtRequest(c: SupabaseCreds, path: string, init?: RequestInit): Promise<unknown> {
  const res = await sbFetch(`${MGMT_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${mgmtToken(c)}`,
      "Content-Type": "application/json",
      ...((init?.headers as Record<string, string> | undefined) || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) msg = j.message;
    } catch { /* JSONでなければ本文をそのまま使う */ }
    throw new Error(`Supabase Management APIエラー（${res.status}）: ${msg}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export interface SupabaseOrganization {
  id: string;
  name: string;
}

/** 組織一覧（プロジェクト作成の宛先確認用） */
export async function supabaseListOrganizations(): Promise<SupabaseOrganization[]> {
  const c = requireMgmtCreds();
  const j = await mgmtRequest(c, "/organizations");
  const list = Array.isArray(j) ? (j as Array<{ id?: string; name?: string }>) : [];
  return list
    .filter((o) => o.id)
    .map((o) => ({ id: String(o.id), name: o.name || "(名称なし)" }));
}

export interface SupabaseProjectInfo {
  ref: string;
  name: string;
  region: string;
  status: string;
}

/** プロジェクトを新規作成する（生のAPI呼び出し。接続の保存はしない） */
export async function supabaseCreateProject(input: {
  name: string;
  organizationId: string;
  region: string;
  dbPass: string;
}): Promise<SupabaseProjectInfo> {
  const c = requireMgmtCreds();
  let j: unknown;
  try {
    j = await mgmtRequest(c, "/projects", {
      method: "POST",
      body: JSON.stringify({
        organization_id: input.organizationId,
        name: input.name,
        region: input.region,
        db_pass: input.dbPass,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const note = /limit|maximum|quota|exceed/i.test(msg)
      ? "\n無料プランのプロジェクト数上限の可能性があります。不要なプロジェクトを削除するか、プランの見直しを検討してください。"
      : "";
    throw new Error(`プロジェクトの作成に失敗しました。${msg}${note}`);
  }
  const p = (j || {}) as { id?: string; ref?: string; name?: string; region?: string; status?: string };
  const ref = p.ref || p.id || "";
  if (!ref) throw new Error("プロジェクトの作成応答にIDが含まれていませんでした");
  return { ref, name: p.name || input.name, region: p.region || input.region, status: p.status || "" };
}

/** プロジェクトの状態を取得する（ACTIVE_HEALTHY が準備完了） */
export async function supabaseGetProject(ref: string): Promise<SupabaseProjectInfo> {
  const c = requireMgmtCreds();
  const j = await mgmtRequest(c, `/projects/${encodeURIComponent(ref)}`);
  const p = (j || {}) as { id?: string; ref?: string; name?: string; region?: string; status?: string };
  return {
    ref: p.ref || p.id || ref,
    name: p.name || "",
    region: p.region || "",
    status: p.status || "",
  };
}

/** プロジェクトのAPIキー（anon / service_role）を取得する */
export async function supabaseGetApiKeys(ref: string): Promise<{ anon: string; serviceRole: string }> {
  const c = requireMgmtCreds();
  const pick = (arr: unknown): { anon: string; serviceRole: string } => {
    const list = Array.isArray(arr) ? (arr as Array<{ api_key?: string; name?: string; type?: string }>) : [];
    let anon = "";
    let serviceRole = "";
    for (const k of list) {
      const key = (k.api_key || "").trim();
      if (!key || key.includes("…")) continue; // マスクされたキーは使わない
      if (k.name === "anon") anon = key;
      else if (k.name === "service_role" || k.type === "secret") serviceRole = key;
    }
    return { anon, serviceRole };
  };
  let r = pick(await mgmtRequest(c, `/projects/${encodeURIComponent(ref)}/api-keys`));
  if (!r.serviceRole) {
    /* 新形式のシークレットキーは reveal=true でないと全文が返らない場合がある */
    r = pick(await mgmtRequest(c, `/projects/${encodeURIComponent(ref)}/api-keys?reveal=true`));
  }
  return r;
}

/** DBパスワードを生成する（24文字、暗号論的乱数） */
function generateDbPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!#$&*+-=";
  const buf = new Uint32Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join("");
}

/**
 * 指定プロジェクトをコネクタの接続先として保存する。
 * Management APIトークン（sbp_ / OAuth）は引き継ぎ、以降のツールも使える状態を保つ。
 */
function saveProjectConnection(ref: string, serviceKey: string): void {
  const st = getState();
  const cur = supabaseCreds();
  const obj: Record<string, string> = {
    url: `https://${ref}.supabase.co`,
    serviceKey,
    sbp: cur?.sbp || "",
  };
  if (cur?.oauthToken) obj.oauthToken = cur.oauthToken;
  update({
    connectors: { ...st.connectors, supabase: JSON.stringify(obj) },
    connectorAccounts: { ...st.connectorAccounts, supabase: `プロジェクト ${ref}` },
  });
}

/* プロジェクト準備完了のポーリング設定（テストでは globalThis の上書きで短縮できる） */
function pollCfg(): { intervalMs: number; timeoutMs: number } {
  const g = globalThis as unknown as { __ELUNTRA_SB_POLL_MS?: number; __ELUNTRA_SB_POLL_TIMEOUT_MS?: number };
  return {
    intervalMs: typeof g.__ELUNTRA_SB_POLL_MS === "number" ? g.__ELUNTRA_SB_POLL_MS : 10_000,
    timeoutMs: typeof g.__ELUNTRA_SB_POLL_TIMEOUT_MS === "number" ? g.__ELUNTRA_SB_POLL_TIMEOUT_MS : 120_000,
  };
}

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitUntilReady(
  ref: string,
  onProgress?: (elapsedSec: number) => void,
): Promise<SupabaseProjectInfo & { ready: boolean }> {
  const { intervalMs, timeoutMs } = pollCfg();
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  for (;;) {
    const p = await supabaseGetProject(ref);
    if (p.status === "ACTIVE_HEALTHY") return { ...p, ready: true };
    if (Date.now() + intervalMs > deadline) return { ...p, ready: false };
    /* 待機が長いと「止まっている」ように見えるため、経過秒数を呼び出し側へ知らせる（v7.2.7） */
    onProgress?.(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
    await sleepMs(intervalMs);
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

/** 組織一覧（エージェント用） */
export async function supabaseOrgs(): Promise<string> {
  const orgs = await supabaseListOrganizations();
  if (!orgs.length) return "Supabaseの組織が見つかりませんでした";
  return `組織一覧（${orgs.length}件）:\n${orgs.map((o) => `- ${o.name}（ID: ${o.id}）`).join("\n")}`;
}

/**
 * プロジェクト作成の一連の流れ（エージェント用）。
 * 組織の解決 → 作成 → 準備完了を待つ → APIキーを取得してコネクタへ保存、までを行う。
 * DBパスワードはこの結果で1回だけ提示する。
 */
export async function supabaseCreateProjectTool(
  args: {
    name?: string;
    orgId?: string;
    region?: string;
  },
  onProgress?: (elapsedSec: number) => void,
): Promise<string> {
  requireMgmtCreds();
  const name = (args.name || "").trim();
  if (!name) return "name（プロジェクト名）を指定してください";
  const orgs = await supabaseListOrganizations();
  let orgId = (args.orgId || "").trim();
  if (!orgId) {
    if (orgs.length === 1) {
      orgId = orgs[0].id;
    } else if (orgs.length === 0) {
      return "Supabaseの組織が見つかりませんでした。先にSupabase側で組織を作成してください";
    } else {
      return (
        "組織が複数あるため、作成先を特定できません。ユーザーにどの組織に作るか確認し、orgId を指定して再実行してください:\n" +
        orgs.map((o) => `- ${o.name}（ID: ${o.id}）`).join("\n")
      );
    }
  }
  const region = (args.region || "").trim() || "ap-northeast-1";
  const dbPass = generateDbPassword();
  const created = await supabaseCreateProject({ name, organizationId: orgId, region, dbPass });
  const ref = created.ref;
  const passNote =
    `データベースパスワード: ${dbPass}\n` +
    "このパスワードはデータベース直接接続用です。保存してください（再表示できません）";
  const st = await waitUntilReady(ref, onProgress);
  if (!st.ready) {
    return [
      `プロジェクト「${name}」を作成しましたが、まだ準備中です（状態: ${st.status || "不明"}）。`,
      `プロジェクトID（ref）: ${ref}`,
      `URL: https://${ref}.supabase.co`,
      `リージョン: ${region}`,
      passNote,
      `少し待ってから supabase_project_setup {ref: "${ref}"} を実行すると、準備が終わっていれば接続を仕上げます。`,
    ].join("\n");
  }
  const keys = await supabaseGetApiKeys(ref);
  if (!keys.serviceRole) {
    return [
      `プロジェクト「${name}」は準備完了しましたが、サービスロールキーを取得できませんでした。`,
      `プロジェクトID（ref）: ${ref}`,
      `URL: https://${ref}.supabase.co`,
      passNote,
      `Supabaseの Settings → API でキーを確認するか、時間を置いて supabase_project_setup {ref: "${ref}"} を実行してください。`,
    ].join("\n");
  }
  saveProjectConnection(ref, keys.serviceRole);
  return [
    `Supabaseプロジェクト「${name}」を作成し、Eluntraに接続しました。`,
    `プロジェクトID（ref）: ${ref}`,
    `URL: https://${ref}.supabase.co`,
    `リージョン: ${region}`,
    passNote,
    "いまの接続先はこのプロジェクトです。supabase_tables / supabase_sql / supabase_auth_users などがすぐ使えます。",
  ].join("\n");
}

/** 作成済みプロジェクトの準備完了を確認し、接続を仕上げる（エージェント用） */
export async function supabaseProjectSetupTool(args: { ref?: string }): Promise<string> {
  requireMgmtCreds();
  const ref = (args.ref || "").trim();
  if (!ref) return "ref（プロジェクトID）を指定してください";
  const p = await supabaseGetProject(ref);
  if (p.status !== "ACTIVE_HEALTHY") {
    return `プロジェクト ${ref} はまだ準備中です（状態: ${p.status || "不明"}）。少し待ってから、もう一度 supabase_project_setup を実行してください`;
  }
  const keys = await supabaseGetApiKeys(ref);
  if (!keys.serviceRole) {
    return "プロジェクトの準備は完了していますが、サービスロールキーを取得できませんでした。Supabaseの Settings → API でキーを確認してください";
  }
  saveProjectConnection(ref, keys.serviceRole);
  return `プロジェクト「${p.name || ref}」（ref: ${ref}）の準備が完了し、Eluntraに接続しました。URL: https://${ref}.supabase.co`;
}
