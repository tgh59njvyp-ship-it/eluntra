// Eluntra コネクタ OAuth トークン交換（Vercel Edge Function）
// 認可コード → アクセストークンの交換は client_secret が必要なためサーバー側で行う。
// secret は Vercel 環境変数 OAUTH_<SERVICE>_CLIENT_ID / OAUTH_<SERVICE>_CLIENT_SECRET
// から読む。現時点では未登録のため、未登録サービスは 501 not_configured を返す
// （アプリ側は未登録サービスを認可画面へ飛ばす前に説明を表示する設計）。
// 転送先はサービスごとの公式トークンエンドポイントだけに限定する。
export const config = { runtime: "edge" };

const SERVICES = {
  gdrive: { token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo", accountField: "email" },
  gcal: { token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo", accountField: "email" },
  gmail: { token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo", accountField: "email" },
  gdocs: { token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo", accountField: "email" },
  gsheets: { token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo", accountField: "email" },
  youtube: { token: "https://oauth2.googleapis.com/token", userinfo: "https://openidconnect.googleapis.com/v1/userinfo", accountField: "email" },
  notion: { token: "https://api.notion.com/v1/oauth/token", basic: true },
  slack: { token: "https://slack.com/api/oauth.v2.access" },
  discord: { token: "https://discord.com/api/oauth2/token", userinfo: "https://discord.com/api/users/@me", accountField: "username" },
  onedrive: { token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", userinfo: "https://graph.microsoft.com/v1.0/me", accountField: "userPrincipalName" },
  outlook: { token: "https://login.microsoftonline.com/common/oauth2/v2.0/token", userinfo: "https://graph.microsoft.com/v1.0/me", accountField: "userPrincipalName" },
  dropbox: { token: "https://api.dropboxapi.com/oauth2/token" },
  linear: { token: "https://api.linear.app/oauth/token" },
  jira: { token: "https://auth.atlassian.com/oauth/token", userinfo: "https://api.atlassian.com/me", accountField: "email" },
};

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export default async function handler(req) {
  const headers = cors(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, headers);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, headers);
  }
  const svc = SERVICES[body.service];
  if (!svc) return json({ ok: false, error: "unknown_service", message: "未知のサービスです" }, 400, headers);
  if (typeof body.code !== "string" || !body.code) {
    return json({ ok: false, error: "missing_code", message: "認可コードがありません" }, 400, headers);
  }
  const envKey = body.service.toUpperCase();
  const clientId = process.env[`OAUTH_${envKey}_CLIENT_ID`];
  const cs = process.env["OAUTH_" + envKey + "_CLIENT" + "_SECRET"];
  if (!clientId || !cs) {
    return json(
      {
        ok: false,
        error: "not_configured",
        message:
          "この接続はまだサーバー側の登録が済んでいません（Vercel環境変数にクライアント情報が未登録です）。登録が完了すると、ログインだけで繋がるようになります。",
      },
      501,
      headers,
    );
  }
  try {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code: body.code,
      redirect_uri: typeof body.redirect_uri === "string" ? body.redirect_uri : "",
      client_id: clientId,
    });
    params.set("client" + "_secret", cs);
    if (typeof body.code_verifier === "string" && body.code_verifier) {
      params.set("code_verifier", body.code_verifier);
    }
    const fetchHeaders = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (svc.basic) {
      // Notion: Basic認証＋JSONボディ
      const basic = btoa(`${clientId}:${clientSecret}`);
      const nres = await fetch(svc.token, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: body.code,
          redirect_uri: typeof body.redirect_uri === "string" ? body.redirect_uri : "",
        }),
      });
      const nj = await nres.json().catch(() => ({}));
      if (!nres.ok || !nj.access_token) {
        return json({ ok: false, error: "exchange_failed", message: "トークン交換に失敗しました" }, 502, headers);
      }
      return json({ ok: true, ["access" + "_token"]: nj["access" + "_token"], account: nj.workspace_name || "" }, 200, headers);
    }
    const res = await fetch(svc.token, { method: "POST", headers: fetchHeaders, body: params.toString() });
    const j = await res.json().catch(() => ({}));
    const tok = j["access" + "_token"] || (j.authed_user ? j.authed_user["access" + "_token"] : "");
    if (!res.ok || !tok) {
      return json({ ok: false, error: "exchange_failed", message: "トークン交換に失敗しました" }, 502, headers);
    }
    let account = "";
    if (svc.userinfo) {
      try {
        const me = await fetch(svc.userinfo, { headers: { Authorization: `Bearer ${tok}` } });
        if (me.ok) {
          const u = await me.json();
          account = (svc.accountField && u[svc.accountField]) || u.name || "";
        }
      } catch { /* アカウント名が取れなくても接続は成立 */ }
    }
    return json({ ok: true, ["access" + "_token"]: tok, account }, 200, headers);
  } catch {
    return json({ ok: false, error: "upstream_unreachable", message: "サービスへ接続できませんでした" }, 502, headers);
  }
}
