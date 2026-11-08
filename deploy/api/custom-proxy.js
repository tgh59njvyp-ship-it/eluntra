// Eluntra カスタムプロバイダー専用中継（Vercel Node Function）
// カスタムプロバイダーは任意のOpenAI互換ホストへつなぐため、許可リスト方式の
// /api/proxy では扱えない。ここでは宛先を限定せず、代わりにSSRFガードで
// 内部ネットワーク宛てを遮断する。通信はこのサーバー経由になるため、
// 接続先がCORSを許可していなくてもブラウザから使える。
// キー（Authorization）はそのまま接続先へ渡すだけで、保存・記録はしない。
// Node ランタイムなのは、ホスト名のDNS解決結果まで検証するため。
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";

export const config = { runtime: "nodejs" };

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10MB
const FORWARD_REQ_HEADERS = ["authorization", "content-type", "accept"];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, accept, x-target-url",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function sendJson(res, status, message, cors) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  res.end(JSON.stringify({ error: { message } }));
}

/* ---------- SSRFガード ---------- */

function ipv4Blocked(a, b) {
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 ループバック
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) // 169.254.0.0/16 リンクローカル（クラウドのメタデータ等）
  );
}

function isBlockedIp(ip) {
  if (!ip) return true;
  let addr = String(ip).toLowerCase();
  // IPv4射影IPv6（::ffff:127.0.0.1）はIPv4として判定する
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
  if (firstNum >= 0xfc00 && firstNum <= 0xfdff) return true; // fc00::/7 ユニークローカル
  if (firstNum >= 0xfe80 && firstNum <= 0xfebf) return true; // fe80::/10 リンクローカル
  return false;
}

/** ホスト名（リテラルIP含む）の解決先がすべて公開アドレスであることを確認する */
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

/* ---------- ハンドラ ---------- */

export default async function handler(req, res) {
  const cors = corsHeaders(req.headers.origin || "");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "POST") {
    sendJson(res, 405, "許可されていないメソッドです", cors);
    return;
  }
  const target = req.headers["x-target-url"];
  if (!target || typeof target !== "string") {
    sendJson(res, 400, "x-target-url がありません", cors);
    return;
  }
  let url;
  try {
    url = new URL(target);
  } catch {
    sendJson(res, 400, "URLが不正です", cors);
    return;
  }
  if (url.protocol !== "https:") {
    sendJson(res, 403, "https の接続先だけが使えます", cors);
    return;
  }
  const hostname = url.hostname.toLowerCase();
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    sendJson(res, 403, "許可されていない接続先です", cors);
    return;
  }
  try {
    await assertPublicHost(hostname);
  } catch (e) {
    if (e && e.code === "BLOCKED_IP") {
      sendJson(res, 403, "許可されていない接続先です", cors);
    } else {
      sendJson(res, 400, "接続先の名前解決ができませんでした", cors);
    }
    return;
  }

  // リクエストボディ（上限つきで読み取る。チャット送信はJSON想定）
  let body = null;
  if (req.method === "POST") {
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          sendJson(res, 413, "リクエストが大きすぎます", cors);
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      sendJson(res, 400, "リクエストの読み取りに失敗しました", cors);
      return;
    }
    body = Buffer.concat(chunks);
  }

  const headers = {};
  for (const name of FORWARD_REQ_HEADERS) {
    const v = req.headers[name];
    if (typeof v === "string" && v) headers[name] = v;
  }
  headers["user-agent"] = "Eluntra/6.4 (+https://eluntra.vercel.app)";

  let upstream;
  try {
    upstream = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: req.method === "POST" ? body : undefined,
      redirect: "manual", // リダイレクトは追従せず、そのまま返す（別ホストへの誘導を防ぐ）
    });
  } catch {
    sendJson(res, 502, "接続先サーバーへ接続できませんでした", cors);
    return;
  }

  res.statusCode = upstream.status;
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  const loc = upstream.headers.get("location");
  if (loc) res.setHeader("Location", loc);

  if (upstream.body) {
    // SSE（ストリーミング応答）をそのまま流す
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}
