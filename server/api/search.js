// Eluntra エージェント用 Web検索（Vercel Edge Function）
// Bing の検索結果ページを取得し、タイトル/URL/スニペットを JSON で返す。
// DuckDuckGo(html/lite)はボット判定(202)を返す環境が多いためフォールバックに回す。
// 検索クエリ以外のユーザー情報は送らない。
export const config = { runtime: "edge" };

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}
function realUrl(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch { return href; }
}
function bingUrl(href) {
  try {
    const u = new URL(decodeEntities(href));
    if (u.hostname.includes("bing.com") && u.pathname.startsWith("/ck/a")) {
      const p = u.searchParams.get("u") || "";
      if (p.startsWith("a1")) {
        const b64 = p.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        const dec = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
        if (/^https?:\/\//.test(dec)) return dec;
      }
      return "";
    }
    return u.toString();
  } catch { return ""; }
}

function parseBing(html) {
  const results = [];
  const chunks = html.split('<li class="b_algo"').slice(1);
  for (const chunk of chunks) {
    if (results.length >= 8) break;
    const a = chunk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = bingUrl(a[1]);
    const title = stripTags(a[2]);
    if (!url || !title || !/^https?:\/\//.test(url)) continue;
    const rest = chunk.slice(a.index + a[0].length, a.index + a[0].length + 4000);
    const pm = rest.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({ title, url, snippet: pm ? stripTags(pm[1]).slice(0, 300) : "" });
  }
  return results;
}

function parseDdg(html) {
  const results = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 8) {
    const url = realUrl(m[1]);
    const title = stripTags(m[2]);
    if (!title || !/^https?:\/\//.test(url)) continue;
    const rest = html.slice(m.index, m.index + 3000);
    const sn = rest.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    results.push({ title, url, snippet: sn ? stripTags(sn[1]).slice(0, 300) : "" });
  }
  return results;
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const headers = { "Content-Type": "application/json", ...cors(origin) };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  const q = new URL(req.url).searchParams.get("q") || "";
  if (!q.trim()) return new Response(JSON.stringify({ error: "q が必要です", results: [] }), { status: 400, headers });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  try {
    let results = [];
    try {
      const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(q)}&count=8`, { headers: { "User-Agent": UA }, signal: ctl.signal });
      if (res.ok) results = parseBing(await res.text());
    } catch { /* DDGへ */ }
    if (!results.length) {
      for (const ep of [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`]) {
        try {
          const res = await fetch(ep, { headers: { "User-Agent": UA }, signal: ctl.signal });
          if (res.ok) { results = parseDdg(await res.text()); if (results.length) break; }
        } catch { /* 次へ */ }
      }
    }
    return new Response(JSON.stringify({ query: q, results }), { headers });
  } catch {
    return new Response(JSON.stringify({ error: "検索サービスへ接続できませんでした", results: [] }), { status: 502, headers });
  } finally {
    clearTimeout(timer);
  }
}
