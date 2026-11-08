// Eluntra エージェント用 ページ本文取得（Vercel Edge Function）
// 指定URLの本文テキストを抽出して返す。SSRF防止つき：
// http/httpsのみ、プライベートIP・localhost・リンクローカルは拒否、
// サイズ上限とタイムアウトあり、リダイレクト先も再検証する。
export const config = { runtime: "edge" };

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Vary: "Origin",
  };
}

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}

function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8000);
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";
  const headers = { "Content-Type": "application/json", ...cors(origin) };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  const raw = new URL(req.url).searchParams.get("url") || "";
  let url;
  try { url = new URL(raw); } catch {
    return new Response(JSON.stringify({ error: "URLが不正です" }), { status: 400, headers });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return new Response(JSON.stringify({ error: "http/https のURLだけ取得できます" }), { status: 400, headers });
  }
  if (isPrivateHost(url.hostname)) {
    return new Response(JSON.stringify({ error: "プライベートなアドレスは取得できません" }), { status: 403, headers });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    let current = url;
    let res = null;
    for (let i = 0; i < 4; i++) {
      res = await fetch(current.toString(), {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; EluntraAgent/5.0)", Accept: "text/html, text/plain" },
        signal: ctl.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        const next = new URL(loc, current);
        if ((next.protocol !== "http:" && next.protocol !== "https:") || isPrivateHost(next.hostname)) {
          return new Response(JSON.stringify({ error: "リダイレクト先が許可されていません" }), { status: 403, headers });
        }
        current = next;
        continue;
      }
      break;
    }
    if (!res || !res.ok) {
      return new Response(JSON.stringify({ error: `取得できませんでした（HTTP ${res ? res.status : "?"}）` }), { status: 502, headers });
    }
    const ct = res.headers.get("content-type") || "";
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 2_000_000) {
      return new Response(JSON.stringify({ error: "ページが大きすぎます（2MBまで）" }), { status: 413, headers });
    }
    const rawText = new TextDecoder().decode(buf);
    const text = ct.includes("html") ? extractText(rawText) : rawText.slice(0, 8000);
    const titleM = rawText.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? titleM[1].replace(/<[^>]*>/g, "").trim().slice(0, 200) : current.hostname;
    return new Response(JSON.stringify({ url: current.toString(), title, text }), { headers });
  } catch {
    return new Response(JSON.stringify({ error: "ページへ接続できませんでした" }), { status: 502, headers });
  } finally {
    clearTimeout(timer);
  }
}
