// Eluntra GitHubデバイスフロー中継（Vercel Edge Function）
// GitHubのデバイス系エンドポイント（github.com/login/device/code と
// github.com/login/oauth/access_token）は CORS ヘッダーを返さないため、
// ブラウザからはこの中継経由でのみ呼べる。転送先はこの2つだけに限定する。
// client_id は公開値。client_secret はデバイスフローでは不要（使わない）。
export const config = { runtime: "edge" };

const CLIENT_ID = "Ov23livoDT2raVlwV2o1";

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

async function forward(url, params, headers) {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  try {
    return json(JSON.parse(text), 200, headers);
  } catch {
    return json({ error: "bad_upstream_response", error_description: text.slice(0, 200) }, 502, headers);
  }
}

export default async function handler(req) {
  const headers = cors(req.headers.get("origin") || "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400, headers);
  }
  try {
    if (body.action === "device_code") {
      return await forward(
        "https://github.com/login/device/code",
        { client_id: CLIENT_ID, scope: "repo read:user" },
        headers,
      );
    }
    if (body.action === "poll" && typeof body.device_code === "string" && body.device_code) {
      return await forward(
        "https://github.com/login/oauth/access_token",
        {
          client_id: CLIENT_ID,
          device_code: body.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        headers,
      );
    }
    return json({ error: "invalid_action" }, 400, headers);
  } catch {
    return json({ error: "upstream_unreachable", error_description: "GitHubへ接続できませんでした" }, 502, headers);
  }
}
