import { getState } from "../store";

/**
 * コネクタレジストリ（17種）。
 * 接続体験は「押すとログイン画面に飛ぶ」ChatGPT式を主役にする（lib/connectors/oauth.ts）。
 * 現時点で実際に接続できるのは、トークン方式で本当に動く5種（GitHub／YouTube／Notion／
 * Slack／Discord、設定の折りたたみ「トークンで接続」から）と、GitHubのデバイスフロー
 * （ただしGitHubアプリ側でデバイスフローの有効化が済んだ場合のみ）、そして Supabase
 * （トークン方式＝プロジェクトURL＋サービスロールキー等。ログイン式はアプリ登録待ち）。
 * その他のサービスは OAuth アプリ登録（1回限り）が済むまで「準備中」と明示し、
 * 接続済みには見せない。
 * トークンは APIキーとは別枠（eluntra_connectors）で端末に保存し、ログイン中は
 * APIキーと同様に本人のアカウント（eluntra_sync）へ同期される（v6.8〜）。
 * ロゴは全種とも公式ブランドマーク（public/logos/conn-<id>.svg、出典は DESIGN.md）。
 */

import { testSupabaseConnection } from "./supabase";

export interface ConnectorDef {
  id: string;
  name: string;
  mono: string;
  color: string;
  /** トークン方式（折りたたみ）が使えるか */
  supported: boolean;
  desc: string;
  fieldLabel?: string;
  fieldPlaceholder?: string;
  help?: string;
}

export const CONNECTORS: ConnectorDef[] = [
  { id: "github", name: "GitHub", mono: "GH", color: "#24292F", supported: true, desc: "リポジトリ一覧をエージェントが参照できます", fieldLabel: "Personal Access Token", fieldPlaceholder: "ghp_… / github_pat_…", help: "リポジトリ一覧をエージェントが参照できます" },
  { id: "youtube", name: "YouTube", mono: "YT", color: "#B3261E", supported: true, desc: "動画検索をエージェントが使えます", fieldLabel: "Data API v3 キー", fieldPlaceholder: "AIza…", help: "動画検索をエージェントが使えます" },
  { id: "notion", name: "Notion", mono: "No", color: "#111111", supported: true, desc: "ページ・データベース検索をエージェントが使えます", fieldLabel: "インテグレーショントークン", fieldPlaceholder: "ntn_… / secret_…", help: "ページ・データベース検索をエージェントが使えます" },
  { id: "slack", name: "Slack", mono: "Sl", color: "#4A154B", supported: true, desc: "接続確認（読み取りは権限に依存します）", fieldLabel: "Bot トークン", fieldPlaceholder: "xoxb-…", help: "接続確認のみ（読み取りは権限に依存します）" },
  { id: "discord", name: "Discord", mono: "Di", color: "#4752C4", supported: true, desc: "接続確認", fieldLabel: "Bot トークン", fieldPlaceholder: "Botトークン", help: "接続確認のみ" },
  { id: "gdrive", name: "Google Drive", mono: "GD", color: "#8A6D00", supported: false, desc: "ファイルの検索・参照" },
  { id: "gcal", name: "Google Calendar", mono: "GC", color: "#1A56DB", supported: false, desc: "予定の確認" },
  { id: "gmail", name: "Gmail", mono: "Gm", color: "#B3261E", supported: false, desc: "メールの検索・要約" },
  { id: "gdocs", name: "Google Docs", mono: "Do", color: "#1A56DB", supported: false, desc: "ドキュメントの参照" },
  { id: "gsheets", name: "Google Sheets", mono: "Sh", color: "#137333", supported: false, desc: "表データの参照" },
  { id: "onedrive", name: "Microsoft OneDrive", mono: "OD", color: "#0F5FA8", supported: false, desc: "ファイルの検索・参照" },
  { id: "outlook", name: "Microsoft Outlook", mono: "Ou", color: "#0F5FA8", supported: false, desc: "メール・予定の確認" },
  { id: "dropbox", name: "Dropbox", mono: "Db", color: "#0F5FA8", supported: false, desc: "ファイルの検索・参照" },
  { id: "linear", name: "Linear", mono: "Li", color: "#5E6AD2", supported: false, desc: "課題の検索" },
  { id: "trello", name: "Trello", mono: "Tr", color: "#0F5FA8", supported: false, desc: "ボード・カードの参照" },
  { id: "jira", name: "Jira", mono: "Ji", color: "#0F5FA8", supported: false, desc: "課題の検索" },
  { id: "supabase", name: "Supabase", mono: "Su", color: "#1E7A4F", supported: true, desc: "データベース・認証（ログイン機能）をエージェントが操作できます", help: "プロジェクトURL＋サービスロールキーで、エージェントがテーブル操作・SQL・認証ユーザー管理を行えます" },
];

export function connectorToken(id: string): string {
  return (getState().connectors[id] || "").trim();
}

export async function testConnector(id: string): Promise<{ ok: boolean; msg: string }> {
  if (id === "supabase") return testSupabaseConnection();
  const token = connectorToken(id);
  if (!token) return { ok: false, msg: "トークンが未入力です" };
  try {
    if (id === "github") {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!res.ok) return { ok: false, msg: `GitHubが ${res.status} を返しました。トークンを確認してください` };
      const j = (await res.json()) as { login?: string };
      return { ok: true, msg: `接続できました（@${j.login || ""}）` };
    }
    if (id === "youtube") {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/search?part=id&q=test&maxResults=1&key=${encodeURIComponent(token)}`,
      );
      if (!res.ok) return { ok: false, msg: `YouTube Data APIが ${res.status} を返しました。キーを確認してください` };
      return { ok: true, msg: "接続できました" };
    }
    if (id === "notion") {
      const res = await fetch("https://api.notion.com/v1/users/me", {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": "2022-06-28",
        },
      });
      if (!res.ok) return { ok: false, msg: `Notionが ${res.status} を返しました。トークンを確認してください（ブラウザのCORS制限で失敗する場合もあります）` };
      return { ok: true, msg: "接続できました" };
    }
    if (id === "slack") {
      const res = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      return j.ok ? { ok: true, msg: "接続できました" } : { ok: false, msg: `Slack: ${j.error || "auth failed"}` };
    }
    if (id === "discord") {
      const res = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      if (!res.ok) return { ok: false, msg: `Discordが ${res.status} を返しました。Botトークンを確認してください` };
      return { ok: true, msg: "接続できました" };
    }
    return { ok: false, msg: "未対応のコネクタです" };
  } catch {
    return { ok: false, msg: "通信できませんでした。電波とトークンを確認してください（ブラウザのCORS制限で直接つなげないサービスもあります）" };
  }
}

/* ---------- エージェント用ツール ---------- */

export async function githubListRepos(): Promise<string> {
  const token = connectorToken("github");
  if (!token) return "GitHubコネクタが未接続です";
  const res = await fetch("https://api.github.com/user/repos?per_page=20&sort=updated", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) return `GitHub APIエラー（${res.status}）`;
  const arr = (await res.json()) as Array<{ full_name?: string; description?: string; html_url?: string }>;
  return arr.map((r) => `- ${r.full_name}: ${r.description || ""} ${r.html_url || ""}`).join("\n") || "リポジトリがありません";
}

export async function youtubeSearch(query: string): Promise<string> {
  const token = connectorToken("youtube");
  if (!token) return "YouTubeコネクタが未接続です";
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=5&key=${encodeURIComponent(token)}`,
  );
  if (!res.ok) return `YouTube APIエラー（${res.status}）`;
  const j = (await res.json()) as { items?: Array<{ id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }> };
  return (j.items || [])
    .map((it) => `- ${it.snippet?.title || ""}（${it.snippet?.channelTitle || ""}） https://www.youtube.com/watch?v=${it.id?.videoId || ""}`)
    .join("\n") || "結果がありません";
}

export async function notionSearch(query: string): Promise<string> {
  const token = connectorToken("notion");
  if (!token) return "Notionコネクタが未接続です";
  const res = await fetch("https://api.notion.com/v1/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, page_size: 5 }),
  });
  if (!res.ok) return `Notion APIエラー（${res.status}）`;
  const j = (await res.json()) as { results?: Array<{ url?: string; properties?: Record<string, unknown>; child_page?: { title?: string } }> };
  return (j.results || []).map((r) => `- ${r.child_page?.title || "(ページ)"} ${r.url || ""}`).join("\n") || "結果がありません";
}
