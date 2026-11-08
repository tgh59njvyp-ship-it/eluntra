// Eluntra エージェント用「ブラウザ」中継（Vercel Node Function）
// 実ブラウザエンジンは Web アプリ内では動かせないため、サーバー側で
// ページ取得とフォーム送信を行う軽量ブラウザ。
// JavaScript の描画は行わない（＝JSで描画されるページや、ログインが
// 必要なページは開けない場合がある）。その制限はアプリ内でも明示する。
// SSRFガードは custom-proxy.js と同じ方式：https のみ、localhost等の拒否、
// リテラルIPとDNS解決後の全アドレスについて内部レンジを拒否。
// リダイレクトは最大5ホップまで追い、その都度ホストを再検証する。
// Cookie はクライアント（エージェント）が保持し、リクエストごとに渡す。
// ページ内容・Cookie・フォーム値は保存も記録もしない。
import { lookup } from "node:dns/promises";

export const config = { runtime: "nodejs" };

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_REDIRECTS = 5;
const TEXT_CAP = 6000;
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1 EluntraBrowser/6.5";

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sendJson(res, status, body, cors) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

/* ---------- SSRFガード（custom-proxy.js と同方式） ---------- */

function ipv4Blocked(a, b) {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isBlockedIp(ip) {
  if (!ip) return true;
  let addr = String(ip).toLowerCase();
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  if (addr.includes(".")) {
    const parts = addr.split(".").map((x) => Number(x));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return ipv4Blocked(parts[0], parts[1]);
  }
  if (addr === "::" || addr === "::1") return true;
  const first = addr.split(":")[0];
  const firstNum = parseInt(first || "0", 16);
  if (Number.isNaN(firstNum)) return true;
  if (firstNum >= 0xfc00 && firstNum <= 0xfdff) return true;
  if (firstNum >= 0xfe80 && firstNum <= 0xfebf) return true;
  return false;
}

async function assertPublicHost(hostname) {
  const addrs = await lookup(hostname, { all: true, verbatim: true });
  if (!addrs.length) {
    const e = new Error("dns_empty");
    e.code = "DNS_EMPTY";
    throw e;
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      const e = new Error("blocked");
      e.code = "BLOCKED_IP";
      throw e;
    }
  }
}

/** URLが https かつ公開ホストであることを確認する。不合格なら理由文字列を返す */
async function checkUrl(url) {
  if (url.protocol !== "https:") return "https のURLだけが開けます";
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return "許可されていない接続先です";
  }
  try {
    await assertPublicHost(hostname);
  } catch (e) {
    if (e && e.code === "BLOCKED_IP") return "許可されていない接続先です";
    return "接続先の名前解決ができませんでした";
  }
  return null;
}

/* ---------- HTMLの軽量パース（外部依存なし） ---------- */

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function extractText(html) {
  const text = html
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
    .trim();
  return { text: text.slice(0, TEXT_CAP), truncated: text.length > TEXT_CAP };
}

function attr(tag, name) {
  const m =
    tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, "i")) ||
    tag.match(new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, "i")) ||
    tag.match(new RegExp(`\\s${name}\\s*=\\s*([^\\s>]+)`, "i"));
  return m ? decodeEntities(m[1]) : "";
}

function extractLinks(html, baseUrl) {
  const links = [];
  const seen = new Set();
  const re = /<a\s[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.length < 60) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const hrefRaw = attr(openTag, "href");
    if (!hrefRaw || /^(javascript:|#|mailto:|tel:|data:)/i.test(hrefRaw)) continue;
    let abs;
    try {
      abs = new URL(hrefRaw, baseUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    links.push({ i: links.length, text: stripTags(m[1]).slice(0, 80), href: abs });
  }
  return links;
}

function extractForms(html, baseUrl) {
  const forms = [];
  const re = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html)) !== null && forms.length < 10) {
    const openTag = m[0].slice(0, m[0].indexOf(">") + 1);
    const method = (attr(openTag, "method") || "GET").toUpperCase() === "POST" ? "POST" : "GET";
    let action;
    try {
      action = new URL(attr(openTag, "action") || baseUrl, baseUrl).toString();
    } catch {
      continue;
    }
    const fields = [];
    const inner = m[1];
    const fieldRe = /<(input|textarea|select)\b[^>]*>(?:([\s\S]*?)<\/\1>)?/gi;
    let fm;
    while ((fm = fieldRe.exec(inner)) !== null && fields.length < 30) {
      const tag = fm[0];
      const kind = fm[1].toLowerCase();
      const name = attr(tag, "name");
      if (!name) continue;
      let type = kind === "input" ? (attr(tag, "type") || "text").toLowerCase() : kind;
      if (["submit", "button", "image", "reset", "file"].includes(type)) continue;
      let value = attr(tag, "value");
      if (kind === "textarea") value = stripTags(fm[2] || "");
      if (kind === "select") {
        const sel = (fm[2] || "").match(/<option\b[^>]*\sselected\b[^>]*>([\s\S]*?)<\/option>/i) ||
          (fm[2] || "").match(/<option\b[^>]*>([\s\S]*?)<\/option>/i);
        if (sel) {
          const optTag = sel[0].slice(0, sel[0].indexOf(">") + 1);
          value = attr(optTag, "value") || stripTags(sel[1]);
        }
      }
      fields.push({ name, type, value: value.slice(0, 500) });
    }
    forms.push({ i: forms.length, method, action, fields });
  }
  return forms;
}

/* ---------- Cookie ---------- */

function cookieHeader(jar) {
  const pairs = Object.entries(jar || {})
    .filter(([k, v]) => k && typeof v === "string")
    .map(([k, v]) => `${k}=${v}`);
  return pairs.length ? pairs.join("; ") : "";
}

function mergeSetCookies(jar, res) {
  let list = [];
  try {
    list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  } catch {
    list = [];
  }
  if (!list.length) {
    const single = res.headers.get("set-cookie");
    if (single) list = [single];
  }
  for (const line of list) {
    const first = line.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    if (!value || /max-age=0(\D|$)/i.test(line)) delete jar[name];
    else jar[name] = value;
  }
}

/* ---------- ページ取得（リダイレクト追尾つき） ---------- */

async function fetchPage(startUrl, { method = "GET", fields = null, jar }) {
  let current = startUrl;
  let curMethod = method;
  let curFields = fields;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const bad = await checkUrl(current);
    if (bad) return { error: bad, status: 403 };
    const headers = {
      "User-Agent": UA,
      Accept: "text/html, application/xhtml+xml, text/plain",
    };
    const cookie = cookieHeader(jar);
    if (cookie) headers.Cookie = cookie;
    let body;
    let url = current;
    if (curMethod === "POST" && curFields) {
      body = new URLSearchParams(curFields).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (curMethod === "GET" && curFields) {
      const u = new URL(current.toString());
      for (const [k, v] of Object.entries(curFields)) u.searchParams.set(k, v);
      url = u;
    }
    let res;
    try {
      res = await fetch(url.toString(), { method: curMethod, headers, body, redirect: "manual" });
    } catch {
      return { error: "ページへ接続できませんでした", status: 502 };
    }
    mergeSetCookies(jar, res);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { error: `リダイレクト先がありません（HTTP ${res.status}）`, status: 502 };
      if (hop === MAX_REDIRECTS) return { error: "リダイレクトが多すぎます", status: 502 };
      let next;
      try {
        next = new URL(loc, current);
      } catch {
        return { error: "リダイレクト先のURLが不正です", status: 502 };
      }
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        curMethod = "GET";
        curFields = null;
      }
      current = next;
      continue;
    }
    if (!res.ok) return { error: `ページがエラーを返しました（HTTP ${res.status}）`, status: 502 };
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html") && !ct.includes("text/plain")) {
      return { error: `対応していないコンテンツ形式です（${ct || "不明"}）`, status: 415 };
    }
    const len = Number(res.headers.get("content-length") || "0");
    if (len > MAX_BODY_BYTES) return { error: "ページが大きすぎます（2MBまで）", status: 413 };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) return { error: "ページが大きすぎます（2MBまで）", status: 413 };
    const raw = new TextDecoder().decode(buf);
    if (!ct.includes("html")) {
      return {
        page: {
          url: current.toString(),
          title: current.hostname,
          text: raw.slice(0, TEXT_CAP),
          links: [],
          forms: [],
          truncated: raw.length > TEXT_CAP,
        },
      };
    }
    const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleM ? stripTags(titleM[1]).slice(0, 200) : current.hostname;
    const { text, truncated } = extractText(raw);
    return {
      page: {
        url: current.toString(),
        title,
        text,
        links: extractLinks(raw, current.toString()),
        forms: extractForms(raw, current.toString()),
        truncated,
      },
    };
  }
  return { error: "リダイレクトが多すぎます", status: 502 };
}

/* ---------- ハンドラ ---------- */

export default async function handler(req, res) {
  const cors = corsHeaders(req.headers.origin || "");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "許可されていないメソッドです" }, cors);
    return;
  }
  let body;
  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > 1024 * 1024) {
        sendJson(res, 413, { error: "リクエストが大きすぎます" }, cors);
        return;
      }
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    sendJson(res, 400, { error: "リクエストJSONが不正です" }, cors);
    return;
  }

  const action = body.action;
  if (action !== "open" && action !== "submit") {
    sendJson(res, 400, { error: "action は open / submit のいずれかです" }, cors);
    return;
  }
  let url;
  try {
    url = new URL(String(body.url || ""));
  } catch {
    sendJson(res, 400, { error: "URLが不正です" }, cors);
    return;
  }
  const jar = {};
  if (body.cookies && typeof body.cookies === "object") {
    for (const [k, v] of Object.entries(body.cookies)) {
      if (typeof v === "string") jar[k] = v;
    }
  }
  const fields =
    body.fields && typeof body.fields === "object"
      ? Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [k, String(v)]))
      : null;
  const method = action === "submit" && String(body.method || "GET").toUpperCase() === "POST" ? "POST" : "GET";

  const result = await fetchPage(url, { method, fields: action === "submit" ? fields : null, jar });
  if (result.error) {
    sendJson(res, result.status || 502, { error: result.error }, cors);
    return;
  }
  sendJson(res, 200, { ok: true, ...result.page, cookies: jar }, cors);
}
