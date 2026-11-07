// Eluntra 中継サーバー（Vercel Edge Function）
// ブラウザから直接つなげない会社のために、リクエストを中継する。
// キーはリクエストごとにヘッダーで受け取り、そのまま各社へ渡すだけ（保存・記録はしない）。
// 中継先は対応30社のAPIドメイン＋サフィックス許可ドメインだけに制限する。
export const config = { runtime: "edge" };

const ALLOWED_HOSTS = new Set([
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "api.anthropic.com",
  "api.mistral.ai",
  "api.groq.com",
  "openrouter.ai",
  "api.cohere.com",
  "api.deepseek.com",
  "api.cloudflare.com",
  "api.sambanova.ai",
  // v5.0 新規
  "api.x.ai",
  "api.together.xyz",
  "api.together.ai",
  "api.fireworks.ai",
  "api.cerebras.ai",
  "api.perplexity.ai",
  "integrate.api.nvidia.com",
  "router.huggingface.co",
  "api.replicate.com",
  "models.github.ai",
  "api.ai21.com",
  "api.aleph-alpha.com",
  "api.novita.ai",
  "api.hyperbolic.xyz",
  "api.siliconflow.cn",
  "aiplatform.googleapis.com",
]);

const ALLOWED_SUFFIXES = [
  ".openai.azure.com", // Azure OpenAI（リソースごとのホスト名）
  ".amazonaws.com", // Amazon Bedrock（リージョンごとのホスト名、署名つきリクエストのみ意味を持つ）
];

function hostAllowed(hostname) {
  if (ALLOWED_HOSTS.has(hostname)) return true;
  if (ALLOWED_SUFFIXES.some((s) => hostname.endsWith(s))) return true;
  if (hostname.endsWith("-aiplatform.googleapis.com")) return true; // Vertex AI（ロケーションごとのホスト名）
  return false;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, content-type, x-api-key, api-key, anthropic-version, anthropic-dangerous-direct-browser-access, x-target-url, x-amz-date, x-amz-content-sha256, x-amz-security-token, prefer, notion-version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const cors = corsHeaders(origin);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  const target = req.headers.get("x-target-url");
  if (!target) {
    return new Response(JSON.stringify({ error: { message: "x-target-url がありません" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  let url;
  try {
    url = new URL(target);
  } catch {
    return new Response(JSON.stringify({ error: { message: "URLが不正です" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  if (url.protocol !== "https:" || !hostAllowed(url.hostname)) {
    return new Response(JSON.stringify({ error: { message: "許可されていない接続先です" } }), {
      status: 403,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }
  const headers = new Headers();
  for (const [k, v] of req.headers.entries()) {
    const lk = k.toLowerCase();
    if (["x-target-url", "host", "origin", "referer", "content-length"].includes(lk)) continue;
    if (lk.startsWith("x-vercel-") || lk.startsWith("x-forwarded-")) continue;
    headers.set(k, v);
  }
  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    });
  } catch {
    return new Response(
      JSON.stringify({ error: { message: "各社サーバーへ接続できませんでした" } }),
      { status: 502, headers: { "Content-Type": "application/json", ...cors } },
    );
  }
  const out = new Headers(upstream.headers);
  out.delete("content-encoding");
  out.delete("content-length");
  for (const [k, v] of Object.entries(cors)) out.set(k, v);
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
