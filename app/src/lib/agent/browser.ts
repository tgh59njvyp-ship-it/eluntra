import { BROWSER_URL } from "../providers/transport";

/**
 * エージェント用「ブラウザ」ツールのクライアント側。
 * 実ブラウザエンジンは Web アプリ内では動かせないため、Vercel の
 * /api/browser（サーバー側の軽量ブラウザ）がページ取得とフォーム送信を行い、
 * ここでは現在のページと Cookie ジャーを保持して click / submit を仲介する。
 * セッション状態は sessionStorage にのみ保存し、クラウド同期の対象にはしない。
 *
 * 制限：JavaScript で描画されるページや、ログインが必要なページは
 * 開けない場合があります。
 */

export interface BrowserLink {
  i: number;
  text: string;
  href: string;
}

export interface BrowserFormField {
  name: string;
  type: string;
  value: string;
}

export interface BrowserForm {
  i: number;
  method: string;
  action: string;
  fields: BrowserFormField[];
}

export interface BrowserPage {
  url: string;
  title: string;
  text: string;
  links: BrowserLink[];
  forms: BrowserForm[];
  truncated?: boolean;
}

interface BrowserSession {
  page: BrowserPage | null;
  cookies: Record<string, string>;
}

const SS_KEY = "eluntra_browser_session";

function loadSession(): BrowserSession {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (raw) {
      const j = JSON.parse(raw) as Partial<BrowserSession>;
      return { page: j.page ?? null, cookies: j.cookies || {} };
    }
  } catch {
    /* 読めなければ空のセッションで始める */
  }
  return { page: null, cookies: {} };
}

let session: BrowserSession = loadSession();

function persist(): void {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(session));
  } catch {
    /* 保存できなくても今回の操作は続けられる */
  }
}

interface BrowserApiResponse extends BrowserPage {
  cookies?: Record<string, string>;
  error?: string;
}

async function callBrowserApi(body: Record<string, unknown>): Promise<BrowserPage> {
  const res = await fetch(BROWSER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, cookies: session.cookies }),
  });
  const j = (await res.json()) as BrowserApiResponse;
  if (!res.ok || j.error) {
    throw new Error(j.error || `ブラウザ中継がエラーを返しました（${res.status}）`);
  }
  const page: BrowserPage = {
    url: j.url, title: j.title, text: j.text, links: j.links || [], forms: j.forms || [], truncated: j.truncated,
  };
  session = { page, cookies: j.cookies || session.cookies };
  persist();
  return page;
}

/** 現在のページを、モデルが次に判断できる要約テキストにする */
export function browserSummary(page: BrowserPage): string {
  const lines: string[] = [];
  lines.push(`ページ: ${page.title || "(タイトルなし)"}`);
  lines.push(`URL: ${page.url}`);
  lines.push("");
  lines.push("本文:");
  lines.push(page.text.slice(0, 4500) || "（本文が空でした）");
  if (page.truncated) lines.push("（本文は長いため省略されています）");
  if (page.links.length) {
    lines.push("");
    lines.push("リンク（click の linkIndex に使う番号）:");
    page.links.forEach((l) => lines.push(`[${l.i}] ${l.text || "(テキストなし)"} → ${l.href}`));
  }
  if (page.forms.length) {
    lines.push("");
    lines.push("フォーム（submit の formIndex に使う番号）:");
    page.forms.forEach((f) => {
      lines.push(`[${f.i}] ${f.method} ${f.action}`);
      f.fields.forEach((fd) => lines.push(`  - ${fd.name}（${fd.type}）${fd.value ? ` = ${fd.value}` : ""}`));
    });
  }
  return lines.join("\n");
}

export async function browserTool(args: Record<string, string>): Promise<string> {
  const action = (args.action || "open").trim();
  try {
    if (action === "read") {
      if (!session.page) return "まだページを開いていません。まず browser の open でURLを開いてください";
      return browserSummary(session.page);
    }
    if (action === "open") {
      const url = (args.url || "").trim();
      if (!url) return "open には url が必要です";
      const page = await callBrowserApi({ action: "open", url });
      return browserSummary(page);
    }
    if (action === "click") {
      if (!session.page) return "まだページを開いていません。まず open でURLを開いてください";
      const idx = Number.parseInt(args.linkIndex || "", 10);
      const link = session.page.links.find((l) => l.i === idx);
      if (!link) return `リンク番号 ${args.linkIndex || "?"} が見つかりません。read で現在のページのリンクを確認してください`;
      const page = await callBrowserApi({ action: "open", url: link.href });
      return browserSummary(page);
    }
    if (action === "submit") {
      if (!session.page) return "まだページを開いていません。まず open でURLを開いてください";
      const idx = Number.parseInt(args.formIndex || "", 10);
      const form = session.page.forms.find((f) => f.i === idx);
      if (!form) return `フォーム番号 ${args.formIndex || "?"} が見つかりません。read で現在のページのフォームを確認してください`;
      let values: Record<string, string> = {};
      if (args.values) {
        try {
          values = JSON.parse(args.values) as Record<string, string>;
        } catch {
          return "values はJSON文字列で指定してください（例： {\"q\":\"検索語\"}）";
        }
      }
      const fields: Record<string, string> = {};
      form.fields.forEach((fd) => {
        fields[fd.name] = fd.value || "";
      });
      Object.entries(values).forEach(([k, v]) => {
        fields[k] = String(v);
      });
      const page = await callBrowserApi({ action: "submit", url: form.action, method: form.method, fields });
      return browserSummary(page);
    }
    return "action は open / click / submit / read のいずれかを指定してください";
  } catch (e) {
    return e instanceof Error ? e.message : "ブラウザ操作に失敗しました";
  }
}
