import { load, save } from "./state";
import type { TestResult } from "./types";

/**
 * コネクタシステム（v5.0）。
 * 実働するのは「トークンを貼るだけで本当に動く」5種だけ：
 * GitHub / YouTube / Notion / Slack / Discord。
 * 残り11種は OAuthアプリの登録が別途必要なため「未対応」と正直に表示し、
 * 接続済みには絶対に見せない。
 * トークンはAPIキーとは別のlocalStorageキーに、端末内のみ保存する。
 */

export interface ConnectorDef {
  id: string;
  name: string;
  mono: string;
  color: string;
  /** トークン方式で実働するか */
  live: boolean;
  tokenLabel?: string;
  tokenHint?: string;
  getTokenUrl?: string;
  /** 未対応の理由 */
  unavailableReason?: string;
  tools: string[];
}

export const CONNECTORS: ConnectorDef[] = [
  { id: "github", name: "GitHub", mono: "GH", color: "#24292F", live: true, tokenLabel: "パーソナルアクセストークン（PAT）", tokenHint: "repo の読み取り権限があるPAT。接続テストは GET /user で行います", getTokenUrl: "https://github.com/settings/tokens", tools: ["自分のリポジトリ一覧"] },
  { id: "youtube", name: "YouTube", mono: "YT", color: "#FF0000", live: true, tokenLabel: "YouTube Data APIキー", tokenHint: "Google Cloudで YouTube Data API v3 を有効にしたAPIキー", getTokenUrl: "https://console.cloud.google.com/apis/credentials", tools: ["動画検索"] },
  { id: "notion", name: "Notion", mono: "No", color: "#000000", live: true, tokenLabel: "インテグレーショントークン", tokenHint: "ntn_ または secret_ で始まるトークン。対象ページをインテグレーションに共有してください", getTokenUrl: "https://www.notion.so/my-integrations", tools: ["ページ・データベース検索"] },
  { id: "slack", name: "Slack", mono: "Sl", color: "#4A154B", live: true, tokenLabel: "Botトークン", tokenHint: "xoxb- で始まるBotトークン。接続テストは auth.test で行います", getTokenUrl: "https://api.slack.com/apps", tools: ["接続確認（auth.test）"] },
  { id: "discord", name: "Discord", mono: "Di", color: "#5865F2", live: true, tokenLabel: "Botトークン", tokenHint: "Discord Developer Portalで作ったBotのトークン", getTokenUrl: "https://discord.com/developers/applications", tools: ["Bot情報の取得"] },
  { id: "gdrive", name: "Google Drive", mono: "GD", color: "#34A853", live: false, tools: [], unavailableReason: "OAuthアプリの登録（Google Cloud側の設定）が必要なため未対応です" },
  { id: "gcal", name: "Google Calendar", mono: "GC", color: "#4285F4", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "gmail", name: "Gmail", mono: "Gm", color: "#EA4335", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "gdocs", name: "Google Docs", mono: "GD", color: "#4285F4", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "gsheets", name: "Google Sheets", mono: "GS", color: "#34A853", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "onedrive", name: "Microsoft OneDrive", mono: "OD", color: "#0078D4", live: false, tools: [], unavailableReason: "OAuthアプリの登録（Microsoft Entra側の設定）が必要なため未対応です" },
  { id: "outlook", name: "Microsoft Outlook", mono: "OL", color: "#0078D4", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "dropbox", name: "Dropbox", mono: "Db", color: "#0061FF", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "linear", name: "Linear", mono: "Li", color: "#5E6AD2", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です（APIキー方式は今後の対応候補）" },
  { id: "trello", name: "Trello", mono: "Tr", color: "#0079BF", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
  { id: "jira", name: "Jira", mono: "Ji", color: "#0052CC", live: false, tools: [], unavailableReason: "OAuthアプリの登録が必要なため未対応です" },
];

const LS_CONN = "eluntra_connectors";
const LS_CONN_TESTED = "eluntra_connectors_tested";

export const connectorTokens = load<Record<string, string>>(LS_CONN, {});
export const connectorTested = load<Record<string, boolean>>(LS_CONN_TESTED, {});

export function persistConnectors(): void {
  save(LS_CONN, connectorTokens);
  save(LS_CONN_TESTED, connectorTested);
}
export function connectorToken(id: string): string {
  return (connectorTokens[id] || "").trim();
}
export function isConnectorReady(id: string): boolean {
  return !!connectorToken(id);
}

async function jfetch(url: string, headers: Record<string, string>): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { headers });
  let json: Record<string, unknown> = {};
  try { json = (await res.json()) as Record<string, unknown>; } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, json };
}

export async function testConnector(id: string): Promise<TestResult> {
  const tok = connectorToken(id);
  if (!tok) return { ok: false, msg: "トークンが未入力です。上の欄に貼ってください。" };
  try {
    let r: { ok: boolean; status: number; json: Record<string, unknown> };
    if (id === "github") {
      r = await jfetch("https://api.github.com/user", { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" });
      if (r.ok) return done(id, `接続できました（${String(r.json.login || "GitHubユーザー")}）。`);
    } else if (id === "youtube") {
      r = await jfetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=1&q=test&key=${encodeURIComponent(tok)}`, {});
      if (r.ok) return done(id, "接続できました。動画検索が使えます。");
    } else if (id === "notion") {
      const res = await fetch("https://api.notion.com/v1/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${tok}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
        body: JSON.stringify({ page_size: 1 }),
      });
      if (res.ok) return done(id, "接続できました。共有されたページを検索できます。");
      r = { ok: false, status: res.status, json: {} };
    } else if (id === "slack") {
      r = await jfetch("https://slack.com/api/auth.test", { Authorization: `Bearer ${tok}` });
      if (r.ok && r.json.ok === true) return done(id, `接続できました（${String(r.json.team || "Slack")}）。`);
      return fail(id, "Slackが接続を拒否しました。対処：Botトークン（xoxb-）と権限を確認してください。");
    } else if (id === "discord") {
      r = await jfetch("https://discord.com/api/v10/users/@me", { Authorization: `Bot ${tok}` });
      if (r.ok) return done(id, `接続できました（Bot: ${String(r.json.username || "")}）。`);
    } else {
      return { ok: false, msg: "このコネクタは未対応です。" };
    }
    return fail(id, `接続できませんでした（HTTP ${r!.status}）。対処：トークンを貼り直してください。`);
  } catch {
    return fail(id, "通信できませんでした。対処：電波を確認してもう一度試してください（会社によってはブラウザ直接接続がCORSで制限される場合があります）。");
  }
}
function done(id: string, msg: string): TestResult {
  connectorTested[id] = true;
  persistConnectors();
  return { ok: true, msg };
}
function fail(id: string, msg: string): TestResult {
  delete connectorTested[id];
  persistConnectors();
  return { ok: false, msg };
}

/* ---------- エージェントから呼べる実働ツール ---------- */

export async function connectorTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "github_repos") {
    const tok = connectorToken("github");
    if (!tok) return "GitHubコネクタが未接続です。設定の「コネクタ」でPATを保存してください。";
    const r = await jfetch("https://api.github.com/user/repos?per_page=20&sort=updated", { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json" });
    if (!r.ok) return `GitHubから取得できませんでした（HTTP ${r.status}）。`;
    const arr = (r.json as unknown) as Array<{ full_name?: string; description?: string; html_url?: string }>;
    if (!Array.isArray(arr) || !arr.length) return "リポジトリが見つかりませんでした。";
    return arr.map((x) => `- ${x.full_name || ""}${x.description ? `：${x.description}` : ""} ${x.html_url || ""}`).join("\n");
  }
  if (name === "youtube_search") {
    const tok = connectorToken("youtube");
    if (!tok) return "YouTubeコネクタが未接続です。設定の「コネクタ」でAPIキーを保存してください。";
    const q = String(args.query || "");
    const r = await jfetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${encodeURIComponent(tok)}`, {});
    if (!r.ok) return `YouTube検索に失敗しました（HTTP ${r.status}）。`;
    const items = ((r.json.items as Array<{ id?: { videoId?: string }; snippet?: { title?: string } }>) || []);
    if (!items.length) return "動画が見つかりませんでした。";
    return items.map((v) => `- ${v.snippet?.title || ""} https://www.youtube.com/watch?v=${v.id?.videoId || ""}`).join("\n");
  }
  if (name === "notion_search") {
    const tok = connectorToken("notion");
    if (!tok) return "Notionコネクタが未接続です。設定の「コネクタ」でトークンを保存してください。";
    const res = await fetch("https://api.notion.com/v1/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ query: String(args.query || ""), page_size: 8 }),
    });
    if (!res.ok) return `Notion検索に失敗しました（HTTP ${res.status}）。`;
    const j = (await res.json()) as { results?: Array<{ url?: string; properties?: Record<string, { title?: Array<{ plain_text?: string }> }>; child_page?: { title?: string } }> };
    const rows = (j.results || []).map((x) => {
      const titleProp = x.properties ? Object.values(x.properties).find((v) => Array.isArray(v.title)) : undefined;
      const title = titleProp?.title?.map((t) => t.plain_text || "").join("") || x.child_page?.title || "（無題）";
      return `- ${title} ${x.url || ""}`;
    });
    return rows.length ? rows.join("\n") : "該当するページがありませんでした（インテグレーションへの共有が必要です）。";
  }
  return `未知のコネクタツールです: ${name}`;
}
