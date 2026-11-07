/* Amazon Bedrock 用の AWS SigV4 署名（WebCrypto で新規実装） */

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, text: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(text));
}

function hexOf(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SigV4Result {
  headers: Record<string, string>;
}

/** SigV4 署名済みヘッダーを作る（service は bedrock） */
export async function signRequest(opts: {
  method: string;
  url: string;
  body: string;
  accessKey: string;
  secret: string;
  region: string;
  service?: string;
}): Promise<SigV4Result> {
  const service = opts.service || "bedrock";
  const u = new URL(opts.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(opts.body || "");
  const headers: Record<string, string> = {
    host: u.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
  };
  if (opts.method !== "GET") headers["content-type"] = "application/json";
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k].trim()}\n`)
    .join("");
  const canonicalRequest = [
    opts.method,
    u.pathname,
    u.search ? u.search.slice(1) : "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const enc = new TextEncoder();
  const kDate = await hmac(enc.encode(`AWS4${opts.secret}`), dateStamp);
  const kRegion = await hmac(kDate, opts.region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hexOf(await hmac(kSigning, stringToSign));
  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers };
}
