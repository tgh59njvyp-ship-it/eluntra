import { getState } from "../store";
import type { ProviderDef } from "../types";

/** 中継サーバー（Vercel Edge Function）。キーは保存・記録されず、そのまま各社へ渡るだけ */
export const PROXY_URL = "https://eluntra.vercel.app/api/proxy";
/** カスタムプロバイダー専用中継（Vercel Node Function）。任意ホスト宛てをSSRFガードつきで中継する */
export const CUSTOM_PROXY_URL = "https://eluntra.vercel.app/api/custom-proxy";
export const SEARCH_URL = "https://eluntra.vercel.app/api/search";
export const FETCHPAGE_URL = "https://eluntra.vercel.app/api/fetchpage";
/** エージェント「ブラウザ」ツールの中継（Vercel Node Function。サーバー側の軽量ブラウザ） */
export const BROWSER_URL = "https://eluntra.vercel.app/api/browser";

/**
 * 通信経路の指定。
 * - "auto": 既定（中継オンなら /api/proxy、オフなら直接）
 * - "direct": 常にブラウザから直接
 * - "backend": 常に /api/custom-proxy 経由（カスタムプロバイダー用。フォールバックなし）
 */
export type RouteMode = "auto" | "direct" | "backend";

function normalizeMode(mode: RouteMode | boolean | undefined): RouteMode {
  if (mode === true) return "direct";
  if (mode === false || mode === undefined) return "auto";
  return mode;
}

/** ユーザー側の問題（キー違い・モデルなし・上限など）だけを表すエラー。それ以外は画面に出さない */
export class UserError extends Error {}

let routeOverride: boolean | null = null;
export function setRouteOverride(v: boolean | null): void {
  routeOverride = v;
}
export function proxyEnabled(): boolean {
  return routeOverride ?? getState().conf.proxyOn !== false;
}

/** 経由オンなら中継へ、オフ／ローカルなら直接つなぐ。backend は常にカスタム専用中継へ */
export async function apiFetch(url: string, opts?: RequestInit, mode: RouteMode | boolean = "auto"): Promise<Response> {
  const m = normalizeMode(mode);
  if (m === "backend") {
    const headers = new Headers(opts?.headers);
    headers.set("x-target-url", url);
    return fetch(CUSTOM_PROXY_URL, { ...opts, headers });
  }
  if (m === "direct" || !proxyEnabled()) return fetch(url, opts);
  const headers = new Headers(opts?.headers);
  headers.set("x-target-url", url);
  return fetch(PROXY_URL, { ...opts, headers });
}

export function friendlyError(status: number, bodyText: string, p: ProviderDef): string {
  let detail = "";
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    detail = j.error?.message || j.message || "";
  } catch {
    detail = String(bodyText || "").slice(0, 160);
  }
  const tail = detail ? `（詳細：${detail}）` : "";
  if (status === 401 || status === 403)
    return `キーが正しくないか、権限がありません。対処：設定で「${p.name}」のキーを貼り直し、「接続テスト」を押してください。${tail}`;
  if (status === 404)
    return `モデルが見つかりませんでした。対処：モデル選択で別のモデルを選ぶか、「一覧を取得」で使えるモデルに更新してください。${tail}`;
  if (status === 429)
    return `利用上限（レート制限）に達しました。対処：少し待って再送するか、各社の利用状況を確認してください。${tail}`;
  if (status === 400)
    return `リクエストが受け付けられませんでした。対処：モデル名と入力内容を確認してください。${tail}`;
  return `通信エラー（${status}）が発生しました。対処：電波とキーを確認して再送してください。${tail}`;
}

export async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  ms = 90000,
  signal?: AbortSignal,
  mode: RouteMode | boolean = "auto",
): Promise<Response> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort("timeout"), ms);
  try {
    return await apiFetch(url, { ...opts, signal: signal ?? ctl.signal }, mode);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new Error("通信できませんでした");
  } finally {
    window.clearTimeout(timer);
  }
}

/** SSE（data: 行）を読みながら断片を組み立てる */
export async function readSse(
  res: Response,
  pick: (json: never) => string,
  onText: (full: string) => void,
): Promise<string> {
  if (!res.body) throw new Error("応答の読み取りに失敗しました。対処：もう一度送ってください。");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const txt = pick(JSON.parse(d) as never);
        if (txt) {
          full += txt;
          onText(full);
        }
      } catch {
        /* 途中行のパース失敗は無視 */
      }
    }
  }
  return full;
}
