import { findProvider } from "./providers";
import { splitSavedKey } from "./state";
import {
  persistModels,
  persistTested,
  runtime,
  state,
} from "./state";
import type { Message, Provider, TestResult } from "./types";

/** HTTPステータスから、日本語＋対処法つきのエラー文を作る */
export function friendlyError(status: number, bodyText: string, p: Provider): string {
  let detail = "";
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    detail = j.error?.message || j.message || "";
  } catch {
    detail = String(bodyText || "").slice(0, 160);
  }
  const tail = detail ? `（詳細：${detail}）` : "";
  if (status === 401 || status === 403)
    return `キーが正しくないか、権限がありません。対処：設定で「${p.name}」のキーを貼り直し、「接続テスト」を押してください。${tail}`;
  if (status === 404)
    return `モデルが見つかりませんでした。対処：モデル選択で別のモデルを選ぶか、「一覧を取得」で使えるモデルに更新してください。${tail}`;
  if (status === 429)
    return `利用上限（レート制限）に達しました。対処：少し待って再送するか、各社の利用状況を確認してください。${tail}`;
  if (status === 400)
    return `リクエストが受け付けられませんでした。対処：モデル名と入力内容を確認してください。${tail}`;
  return `通信エラー（${status}）が発生しました。対処：電波とキーを確認して再送してください。${tail}`;
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit,
  ms = 90000,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort("timeout"), ms);
  try {
    return await apiFetch(url, { ...opts, signal: runtime.abortCtl?.signal ?? ctl.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      host = "";
    }
    const orig = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new Error(
      `通信できませんでした（接続先：${host || "不明"}／方式：${proxyEnabled() ? "サーバー経由" : "直接接続"}／詳細：${orig}／版：v4.10）。対処：電波の良い場所でもう一度送ってください。それでも直らない場合は、この文面をそのまま教えてください。`,
    );
  } finally {
    window.clearTimeout(timer);
  }
}

/** 中継サーバー（Vercel）。ブラウザから直接つなげない会社のために経由する */
export const PROXY_URL = "https://eluntra.vercel.app/api/proxy";

export function proxyEnabled(): boolean {
  return state.conf.proxyOn !== false;
}

const SAMBA_PROXY_MSG =
  "SambaNovaはブラウザから直接つなげないため、設定の「接続」で「サーバー経由で接続」をオンにしてください。オンにすると中継サーバー経由で使えます。";

/** 経由がオンなら中継サーバーへ、オフなら各社へ直接つなぐ */
export async function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
  if (!proxyEnabled()) return fetch(url, opts);
  const headers = new Headers(opts?.headers);
  headers.set("x-target-url", url);
  return fetch(PROXY_URL, { ...opts, headers });
}

/** Cloudflareは保存キーが "AccountID::トークン" 形式。実ベースURLと実トークンに直す */
export function effBase(p: Provider, key: string): string {
  if (p.id !== "cloudflare") return p.base;
  return p.base.replace("{account}", splitSavedKey(p.id, key).acct);
}
export function effToken(p: Provider, key: string): string {
  if (p.id !== "cloudflare") return key;
  return splitSavedKey(p.id, key).token;
}

function modelsRequest(p: Provider, key: string): Promise<Response> {
  if (p.type === "gemini") {
    return apiFetch(`${p.base}/models?key=${encodeURIComponent(key)}`);
  }
  if (p.type === "anthropic") {
    return apiFetch(`${p.base}/models`, {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
  }
  if (p.type === "cohere") {
    return apiFetch("https://api.cohere.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
  }
  return apiFetch(`${effBase(p, key)}/models`, {
    headers: { Authorization: `Bearer ${effToken(p, key)}` },
  });
}

/** モデル一覧APIで疎通確認する */
export async function testConnection(pid: string): Promise<TestResult> {
  const p = findProvider(pid);
  const key = (state.keys[pid] || "").trim();
  if (!key) return { ok: false, msg: "キーが未入力です。上の欄にキーを貼ってください。" };
  if (pid === "sambanova" && !proxyEnabled())
    return { ok: false, msg: SAMBA_PROXY_MSG };
  try {
    const res = await modelsRequest(p, key);
    if (res.ok) {
      state.tested[pid] = true;
      persistTested();
      return { ok: true, msg: "接続できました。このキーでチャットできます。" };
    }
    const t = await res.text();
    delete state.tested[pid];
    persistTested();
    return { ok: false, msg: friendlyError(res.status, t, p) };
  } catch {
    if (pid === "sambanova") {
      return {
        ok: false,
        msg: "中継サーバー経由でもSambaNovaへ通信できませんでした。対処：電波を確認し、少し待ってからもう一度試してください。",
      };
    }
    return {
      ok: false,
      msg: "通信できませんでした。対処：電波を確認し、キーが正しいか見直してください。（ブラウザから各社APIへ直接つなぐ方式のため、会社によっては接続テストだけ失敗し、チャットは使える場合があります）",
    };
  }
}

/** 自分のキーで実際に使えるモデル一覧を取得して保存する */
export async function fetchModels(pid: string): Promise<string[]> {
  const p = findProvider(pid);
  const key = (state.keys[pid] || "").trim();
  if (!key) throw new Error(`キーが未設定です。先に設定で${p.name}のキーを保存してください。`);
  if (pid === "sambanova" && !proxyEnabled()) throw new Error(SAMBA_PROXY_MSG);
  const res = await modelsRequest(p, key);
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), p));
  const j = (await res.json()) as {
    models?: Array<{ id?: string; name?: string } | string>;
    data?: Array<{ id?: string; name?: string } | string>;
  };
  let ids: string[] = [];
  if (p.type === "gemini") {
    ids = (j.models || [])
      .map((m) => (typeof m === "string" ? m : m.name || "").replace(/^models\//, ""))
      .filter((id) => id && !id.includes("embedding") && !id.includes("aqa"));
  } else {
    ids = (j.data || j.models || []).map((m) =>
      typeof m === "string" ? m : m.id || m.name || "",
    ).filter(Boolean);
  }
  if (pid === "openai") ids = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id));
  ids = [...new Set(ids)].sort();
  if (!ids.length) throw new Error("モデル一覧が空でした。標準モデルのまま使ってください。");
  state.fetchedModels[pid] = ids;
  persistModels();
  state.tested[pid] = true;
  persistTested();
  return ids;
}

/* ---------- チャット送信（会社ごとの形式差をここで吸収） ---------- */

type OnDelta = (full: string) => void;

async function readSse(
  res: Response,
  pick: (json: never) => string,
): Promise<string> {
  if (!res.body) throw new Error("応答の読み取りに失敗しました。対処：もう一度送ってください。");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      try {
        const txt = pick(JSON.parse(d) as never);
        if (txt) {
          full += txt;
        }
      } catch {
        /* 途中行のパース失敗は無視して読み進める */
      }
    }
  }
  return full;
}

/** OpenAI互換（OpenAI / Mistral / Groq / OpenRouter / DeepSeek） */
export async function callOpenAI(
  p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta,
): Promise<string> {
  const msgs: Array<{ role: string; content: string }> = [];
  if (state.conf.system) msgs.push({ role: "system", content: state.conf.system });
  history.forEach((m) => msgs.push({ role: m.role, content: m.content }));
  const res = await fetchWithTimeout(`${effBase(p, key)}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${effToken(p, key)}` },
    body: JSON.stringify({ model, messages: msgs, temperature: state.conf.temp, stream: true }),
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), p));
  let full = "";
  full = await readSse(res, (j: { choices?: Array<{ delta?: { content?: string } }> }) => {
    const delta = j.choices?.[0]?.delta?.content || "";
    if (delta) {
      full += delta;
      onDelta(full);
    }
    return delta;
  });
  return full;
}

/** 連続する同じ役割の発言を1つにまとめる（Gemini／Anthropicの交互必須対策） */
function mergedHistory(history: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = last.content + "\n\n" + m.content;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/** Google Gemini（streamGenerateContent / SSE） */
export async function callGemini(
  p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta,
): Promise<string> {
  const contents = mergedHistory(history).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const body: Record<string, unknown> = {
    contents,
    generationConfig: { temperature: state.conf.temp },
  };
  if (state.conf.system) body.systemInstruction = { parts: [{ text: state.conf.system }] };
  const url = `${p.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), p));
  let full = "";
  full = await readSse(
    res,
    (j: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }) => {
      const txt = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
      if (txt) {
        full += txt;
        onDelta(full);
      }
      return txt;
    },
  );
  if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
  return full;
}

/** Anthropic（Messages API、非ストリーミング） */
export async function callAnthropic(
  p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta,
): Promise<string> {
  const msgs = mergedHistory(history).map((m) => ({ role: m.role, content: m.content }));
  const body: Record<string, unknown> = {
    model, max_tokens: 4096, messages: msgs, temperature: state.conf.temp,
  };
  if (state.conf.system) body.system = state.conf.system;
  const res = await fetchWithTimeout(`${p.base}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), p));
  const j = (await res.json()) as { content?: Array<{ text?: string }> };
  const full = (j.content || []).map((c) => c.text || "").join("");
  if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
  onDelta(full);
  return full;
}

/** Cohere（Chat API v2、非ストリーミング） */
export async function callCohere(
  p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta,
): Promise<string> {
  const msgs = history.map((m) => ({ role: m.role, content: m.content }));
  const body = {
    model,
    messages: state.conf.system
      ? [{ role: "system", content: state.conf.system }, ...msgs]
      : msgs,
    temperature: state.conf.temp,
  };
  const res = await fetchWithTimeout(`${p.base}/v2/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), p));
  const j = (await res.json()) as { message?: { content?: Array<{ text?: string }> } };
  const full = (j.message?.content || []).map((c) => c.text || "").join("");
  if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
  onDelta(full);
  return full;
}

/** プロバイダー種別に応じて送信関数を選ぶ */
export function callChat(
  p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta,
): Promise<string> {
  if (p.id === "sambanova" && !proxyEnabled()) throw new Error(SAMBA_PROXY_MSG);
  switch (p.type) {
    case "gemini":
      return callGemini(p, key, model, history, onDelta);
    case "anthropic":
      return callAnthropic(p, key, model, history, onDelta);
    case "cohere":
      return callCohere(p, key, model, history, onDelta);
    default:
      return callOpenAI(p, key, model, history, onDelta);
  }
}
