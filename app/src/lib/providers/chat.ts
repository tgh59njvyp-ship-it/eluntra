import { effectiveBase, effectiveToken, getState, isCustomId, keyFieldsOf, update, type ModelFlag } from "../store";
import type { ChatMessage, Effort, ProviderDef, SourceLink, TestResult } from "../types";
import { signRequest } from "./bedrock";
import { apiFetch, fetchWithTimeout, friendlyError, proxyEnabled, readSse, setRouteOverride, throwHttpError, UserError, type RouteMode } from "./transport";

/**
 * プロバイダーアダプター群（新規実装）。
 * 共通インターフェース: testConnection / fetchModels / streamChat / completeChat。
 * 会社ごとの認証・形式差はこのファイルの中で吸収する。
 */

type OnDelta = (full: string) => void;

export interface ChatResult {
  text: string;
  sources?: SourceLink[];
}

const SAMBA_MSG =
  "SambaNovaはブラウザから直接つなげないため、設定の「接続」で「サーバー経由で接続」をオンにしてください。";

/* ---------- 思考レベル（実リクエストへの反映） ---------- */

function effortBoost(effort: Effort): string {
  if (effort === "low") return "回答は簡潔にしてください。";
  if (effort === "high") return "答える前に段階的に考え、根拠を確認してから答えてください。";
  if (effort === "super")
    return "最大限深く分析し、多段階で検証してから、検証済みの結論を答えてください。";
  return "";
}

function effortBody(p: ProviderDef, model: string, effort: Effort): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.kind === "openai" || p.kind === "github") {
    // reasoning_effort を受け付けることが知られているモデル系統だけに付ける
    if (/^(o\d|gpt-5)/.test(model) || p.id === "openrouter" || p.id === "deepseek") {
      if (p.id !== "deepseek" || model.includes("reasoner")) {
        out.reasoning_effort = effort === "super" ? "high" : effort;
      }
    }
  }
  return out;
}

/**
 * temperature を送ると 400 になるモデル系統（推論モデル）。
 * OpenAI の o 系 / GPT-5 系は temperature の任意値を受け付けず、DeepSeek reasoner も同様。
 * 通常チャットは経路フォールバック裏で失敗が見えにくいが、complete 経路では即エラーになるため、
 * 該当モデルには temperature 自体を送らない。
 */
function samplingRestricted(p: ProviderDef, model: string): boolean {
  if (/^(o\d|gpt-5)/.test(model)) return true;
  if (p.id === "openrouter" && /(^|\/)(o\d|gpt-5)/.test(model)) return true;
  if (p.id === "deepseek" && model.includes("reasoner")) return true;
  return false;
}

function systemText(p: ProviderDef, effort: Effort): string {
  const base = getState().conf.system || "";
  const boost = effortBoost(effort);
  return [base, boost].filter(Boolean).join("\n");
}

function mergedHistory(history: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content;
    else out.push({ ...m });
  }
  return out;
}

function lastUserImages(history: ChatMessage[]) {
  for (let i = history.length - 1; i >= 0; i--) {
    const at = history[i].attachments?.filter((a) => a.kind === "image") || [];
    if (at.length) return at;
  }
  return [];
}

function textWithAttachments(m: ChatMessage): string {
  const texts = (m.attachments || []).filter((a) => a.kind === "text");
  if (!texts.length) return m.content;
  const joined = texts.map((t) => `--- 添付ファイル: ${t.name} ---\n${t.text || ""}`).join("\n\n");
  return m.content ? `${m.content}\n\n${joined}` : joined;
}

/* ---------- OpenAI互換 ---------- */

function openaiMessages(p: ProviderDef, history: ChatMessage[], effort: Effort) {
  const msgs: Array<Record<string, unknown>> = [];
  const sys = systemText(p, effort);
  if (sys) msgs.push({ role: "system", content: sys });
  const images = lastUserImages(history);
  history.forEach((m, idx) => {
    const text = textWithAttachments(m);
    const isLastUser = m.role === "user" && idx === history.length - 1 && images.length && p.vision;
    if (isLastUser) {
      const parts: Array<Record<string, unknown>> = [{ type: "text", text }];
      images.forEach((im) => parts.push({ type: "image_url", image_url: { url: im.dataUrl || "" } }));
      msgs.push({ role: m.role, content: parts });
    } else {
      msgs.push({ role: m.role, content: text });
    }
  });
  return msgs;
}

/** カスタム等のベースURL必須プロバイダーで未入力のときの案内 */
function missingBaseError(p: ProviderDef): UserError {
  return new UserError(
    `ベースURLが未入力です。対処：設定の「カスタムプロバイダー」で「${p.name}」を開き、ベースURLを入力して保存してください。`,
  );
}

/** プロバイダーごとの通信経路（カスタムはバックエンド中継、ローカルは直接、それ以外は自動） */
function routeModeOf(p: ProviderDef): RouteMode {
  if (p.backendProxy) return "backend";
  if (p.local) return "direct";
  return "auto";
}

async function streamOpenAI(p: ProviderDef, model: string, history: ChatMessage[], onDelta: OnDelta, signal?: AbortSignal): Promise<ChatResult> {
  const key = effectiveToken(p.id);
  const base = effectiveBase(p.id);
  if (p.backendProxy && !base) throw missingBaseError(p);
  const effort = getState().conf.effort;
  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages(p, history, effort),
    stream: true,
    ...effortBody(p, model, effort),
  };
  if (!samplingRestricted(p, model)) body.temperature = getState().conf.temp;
  const path = p.chatPath || "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetchWithTimeout(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }, 90000, signal, routeModeOf(p));
  if (!res.ok) await throwHttpError(res, p);
  const text = await readSse(
    res,
    (j: { choices?: Array<{ delta?: { content?: string } }> }) => j.choices?.[0]?.delta?.content || "",
    onDelta,
  );
  return { text };
}

async function completeOpenAI(p: ProviderDef, model: string, history: ChatMessage[], signal?: AbortSignal): Promise<ChatResult> {
  const key = effectiveToken(p.id);
  const base = effectiveBase(p.id);
  if (p.backendProxy && !base) throw missingBaseError(p);
  const effort = getState().conf.effort;
  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages(p, history, effort),
    ...effortBody(p, model, effort),
  };
  if (!samplingRestricted(p, model)) body.temperature = getState().conf.temp;
  const path = p.chatPath || "/chat/completions";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetchWithTimeout(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }, 90000, signal, routeModeOf(p));
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
    search_results?: Array<{ title?: string; url?: string }>;
  };
  const text = j.choices?.[0]?.message?.content || "";
  const sources: SourceLink[] = [];
  (j.citations || []).forEach((u, i) => {
    if (typeof u === "string") sources.push({ title: `出典 ${i + 1}`, url: u });
  });
  (j.search_results || []).forEach((s) => {
    if (s.url) sources.push({ title: s.title || s.url, url: s.url });
  });
  return { text, sources: sources.length ? sources : undefined };
}

/* ---------- Gemini / Vertex ---------- */

/**
 * Gemini の思考設定はモデル系列ごとに正しい形が違うため、系列に合わせて出し分ける。
 * - Gemini 3 系: thinkingLevel を使う（thinkingBudget は 3 系の指定方法ではない）
 * - Gemini 2.5 系: thinkingBudget。ただし Pro は 0（無効化）を受け付けないので最小値に丸める
 * - それ以外（2.0 系など）: thinkingConfig 自体を送らない（未対応モデルでは 400 になるため）
 */
function geminiThinkingConfig(model: string, effort: Effort): Record<string, unknown> | undefined {
  if (/gemini-3/.test(model)) {
    const isPro = model.includes("pro");
    const level = effort === "low" ? "low" : effort === "medium" ? (isPro ? "high" : "medium") : "high";
    return { thinkingLevel: level };
  }
  if (/gemini-2\.5/.test(model)) {
    let budget = effort === "low" ? 0 : effort === "medium" ? 2048 : effort === "high" ? 8192 : -1;
    if (model.includes("pro") && budget === 0) budget = 128;
    return { thinkingBudget: budget };
  }
  return undefined;
}

function geminiBody(p: ProviderDef, history: ChatMessage[], effort: Effort, model = "") {
  const contents = mergedHistory(history).map((m) => {
    const parts: Array<Record<string, unknown>> = [{ text: textWithAttachments(m) }];
    if (m.role === "user" && p.vision) {
      (m.attachments || [])
        .filter((a) => a.kind === "image")
        .forEach((im) => {
          const data = (im.dataUrl || "").split(",")[1] || "";
          parts.push({ inlineData: { mimeType: im.mime || "image/png", data } });
        });
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const generationConfig: Record<string, unknown> = { temperature: getState().conf.temp };
  const tc = geminiThinkingConfig(model, effort);
  if (tc) generationConfig.thinkingConfig = tc;
  const body: Record<string, unknown> = { contents, generationConfig };
  const sys = systemText(p, effort);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  return body;
}

async function streamGemini(p: ProviderDef, model: string, history: ChatMessage[], onDelta: OnDelta, signal?: AbortSignal): Promise<ChatResult> {
  const key = effectiveToken(p.id);
  const url = `${p.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(geminiBody(p, history, getState().conf.effort, model)),
  }, 90000, signal);
  if (!res.ok) await throwHttpError(res, p);
  const text = await readSse(
    res,
    (j: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }) =>
      (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join(""),
    onDelta,
  );
  if (!text) throw new Error("応答が空でした");
  return { text };
}

async function completeVertexOrGemini(p: ProviderDef, model: string, history: ChatMessage[], onDelta?: OnDelta): Promise<ChatResult> {
  const effort = getState().conf.effort;
  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (p.kind === "vertex") {
    const vals = keyFieldsOf(p.id, getState().keys[p.id] || "");
    url = `https://${vals.location || "us-central1"}-aiplatform.googleapis.com/v1/projects/${vals.project}/locations/${vals.location || "us-central1"}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
    headers.Authorization = `Bearer ${vals.token || ""}`;
  } else {
    const key = effectiveToken(p.id);
    url = `${p.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
  }
  const res = await fetchWithTimeout(url, { method: "POST", headers, body: JSON.stringify(geminiBody(p, history, effort, model)) });
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
  if (!text) throw new Error("応答が空でした");
  onDelta?.(text);
  return { text };
}

/* ---------- Anthropic ---------- */

async function completeAnthropic(p: ProviderDef, model: string, history: ChatMessage[], onDelta?: OnDelta): Promise<ChatResult> {
  const key = effectiveToken(p.id);
  const effort = getState().conf.effort;
  const budgets: Record<Effort, number> = { low: 1024, medium: 4096, high: 16000, super: 32000 };
  const budget = budgets[effort];
  const msgs = mergedHistory(history).map((m) => {
    if (m.role === "user" && p.vision && (m.attachments || []).some((a) => a.kind === "image")) {
      const blocks: Array<Record<string, unknown>> = [{ type: "text", text: textWithAttachments(m) }];
      (m.attachments || [])
        .filter((a) => a.kind === "image")
        .forEach((im) => {
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: im.mime || "image/png", data: (im.dataUrl || "").split(",")[1] || "" },
          });
        });
      return { role: m.role, content: blocks };
    }
    return { role: m.role, content: textWithAttachments(m) };
  });
  const body: Record<string, unknown> = {
    model,
    messages: msgs,
    max_tokens: budget + 4096,
  };
  // 拡張思考が有効な間、Anthropic API は temperature の併記を 400 で拒否する
  // （temperature は 1 以外を指定できない）。思考オフのときだけ temperature を送る
  if (effort !== "low") body.thinking = { type: "enabled", budget_tokens: budget };
  else body.temperature = getState().conf.temp;
  const sys = systemText(p, effort);
  if (sys) body.system = sys;
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
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("");
  if (!text) throw new Error("応答が空でした");
  onDelta?.(text);
  return { text };
}

/* ---------- Cohere ---------- */

async function completeCohere(p: ProviderDef, model: string, history: ChatMessage[], onDelta?: OnDelta): Promise<ChatResult> {
  const key = effectiveToken(p.id);
  const effort = getState().conf.effort;
  const msgs = history.map((m) => ({ role: m.role, content: textWithAttachments(m) }));
  const sys = systemText(p, effort);
  const body = {
    model,
    messages: sys ? [{ role: "system", content: sys }, ...msgs] : msgs,
    temperature: getState().conf.temp,
  };
  const res = await fetchWithTimeout(`${p.base}/v2/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as { message?: { content?: Array<{ text?: string }> } };
  const text = (j.message?.content || []).map((c) => c.text || "").join("");
  if (!text) throw new Error("応答が空でした");
  onDelta?.(text);
  return { text };
}

/* ---------- Replicate ---------- */

async function completeReplicate(p: ProviderDef, model: string, history: ChatMessage[], onDelta?: OnDelta, signal?: AbortSignal): Promise<ChatResult> {
  const key = effectiveToken(p.id);
  const prompt = history.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${textWithAttachments(m)}`).join("\n\n") + "\n\nAssistant:";
  const sys = systemText(p, getState().conf.effort);
  const create = await fetchWithTimeout(`${p.base}/models/${model}/predictions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, Prefer: "wait" },
    body: JSON.stringify({ input: { prompt, system_prompt: sys, max_tokens: 2048 } }),
  }, 120000, signal);
  if (!create.ok) await throwHttpError(create, p);
  let pred = (await create.json()) as { id?: string; status?: string; output?: unknown; error?: string };
  let tries = 0;
  while (pred.status && !["succeeded", "failed", "canceled"].includes(pred.status) && tries < 30) {
    await new Promise((r) => setTimeout(r, 2500));
    const poll = await fetchWithTimeout(`${p.base}/predictions/${pred.id}`, {
      headers: { Authorization: `Bearer ${key}` },
    }, 30000, signal);
    if (!poll.ok) break;
    pred = (await poll.json()) as typeof pred;
    tries++;
  }
  if (pred.status === "failed" || pred.status === "canceled") {
    throw new UserError(`Replicateの実行に失敗しました。対処：モデルを変えるか、Replicate側のモデルページで入力形式を確認してください。${pred.error ? `（詳細：${pred.error}）` : ""}`);
  }
  const out = pred.output;
  const text = Array.isArray(out) ? out.join("") : typeof out === "string" ? out : "";
  if (!text) throw new Error("応答が空でした");
  onDelta?.(text);
  return { text };
}

/* ---------- Bedrock（Converse） ---------- */

function bedrockCreds(p: ProviderDef) {
  const vals = keyFieldsOf(p.id, getState().keys[p.id] || "");
  return { accessKey: vals.accessKey || "", secret: vals.secret || "", region: (vals.region || "us-east-1").trim() };
}

async function completeBedrock(p: ProviderDef, model: string, history: ChatMessage[], onDelta?: OnDelta): Promise<ChatResult> {
  const { accessKey, secret, region } = bedrockCreds(p);
  const effort = getState().conf.effort;
  const messages = mergedHistory(history).map((m) => ({
    role: m.role,
    content: [{ text: textWithAttachments(m) }],
  }));
  const bodyObj: Record<string, unknown> = {
    messages,
    inferenceConfig: { temperature: getState().conf.temp, maxTokens: 4096 },
  };
  const sys = systemText(p, effort);
  if (sys) bodyObj.system = [{ text: sys }];
  const body = JSON.stringify(bodyObj);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
  const { headers } = await signRequest({ method: "POST", url, body, accessKey, secret, region });
  const res = await fetchWithTimeout(url, { method: "POST", headers, body });
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as { output?: { message?: { content?: Array<{ text?: string }> } } };
  const text = (j.output?.message?.content || []).map((c) => c.text || "").join("");
  if (!text) throw new Error("応答が空でした");
  onDelta?.(text);
  return { text };
}

/* ---------- Azure ---------- */

async function completeAzure(p: ProviderDef, model: string, history: ChatMessage[], onDelta?: OnDelta, signal?: AbortSignal): Promise<ChatResult> {
  const endpoint = effectiveBase(p.id);
  const key = effectiveToken(p.id);
  const effort = getState().conf.effort;
  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages(p, history, effort),
  };
  if (!samplingRestricted(p, model)) body.temperature = getState().conf.temp;
  const url = `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-10-21`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": key },
    body: JSON.stringify(body),
  }, 90000, signal);
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = j.choices?.[0]?.message?.content || "";
  if (!text) throw new Error("応答が空でした");
  onDelta?.(text);
  return { text };
}

/* ---------- ディスパッチ ---------- */

export function completeChat(p: ProviderDef, model: string, history: ChatMessage[], signal?: AbortSignal): Promise<ChatResult> {
  if (p.id === "sambanova" && !proxyEnabled()) return Promise.reject(new Error(SAMBA_MSG));
  switch (p.kind) {
    case "gemini":
    case "vertex":
      return completeVertexOrGemini(p, model, history);
    case "anthropic":
      return completeAnthropic(p, model, history);
    case "cohere":
      return completeCohere(p, model, history);
    case "replicate":
      return completeReplicate(p, model, history, undefined, signal);
    case "bedrock":
      return completeBedrock(p, model, history);
    case "azure":
      return completeAzure(p, model, history, undefined, signal);
    default:
      return completeOpenAI(p, model, history, signal);
  }
}

/**
 * completeChat の経路フォールバック版（エージェント用）。
 * completeChat は単一経路しか試さないため、中継が一時的に失敗したり、直接接続が
 * CORS で弾かれる会社だったりすると、通常チャット（streamWithFallback で経路を
 * 切り替えて復旧する）では問題ないのにエージェントだけ全滅していた。
 * こちらも失敗時に経路を切り替えて再送する。ユーザー側の問題（UserError）と中断は再送しない。
 */
export async function completeWithFallback(
  p: ProviderDef,
  model: string,
  history: ChatMessage[],
  signal?: AbortSignal,
): Promise<ChatResult> {
  const routes: Array<boolean | null> = p.local || p.backendProxy ? [null] : [null, getState().conf.proxyOn === false];
  let lastErr: unknown = null;
  for (const r of routes) {
    setRouteOverride(r);
    try {
      const result = await completeChat(p, model, history, signal);
      setRouteOverride(null);
      return result;
    } catch (e) {
      if (e instanceof UserError || (e instanceof DOMException && e.name === "AbortError")) {
        setRouteOverride(null);
        throw e;
      }
      lastErr = e;
    }
  }
  setRouteOverride(null);
  throw lastErr instanceof Error ? lastErr : new Error("通信できませんでした");
}

export function streamChat(p: ProviderDef, model: string, history: ChatMessage[], onDelta: OnDelta, signal?: AbortSignal): Promise<ChatResult> {
  if (p.id === "sambanova" && !proxyEnabled()) return Promise.reject(new Error(SAMBA_MSG));
  switch (p.kind) {
    case "openai":
    case "github":
    case "perplexity":
      return streamOpenAI(p, model, history, onDelta, signal);
    case "gemini":
      return streamGemini(p, model, history, onDelta, signal);
    default:
      // ストリーミング形式が会社ごとに異なるものは、完了形で取得して一括表示する
      return (async () => {
        const r = await completeChat(p, model, history, signal);
        onDelta(r.text);
        return r;
      })();
  }
}

/**
 * 送信の自動リカバリ：現在の経路で失敗したら経路を切り替えて再送する。
 * ユーザー側の問題（UserError）と中断はそのまま投げる。途中まで届いた文章は答えとして返す。
 */
export async function streamWithFallback(
  p: ProviderDef,
  model: string,
  history: ChatMessage[],
  onDelta: OnDelta,
  signal?: AbortSignal,
): Promise<ChatResult> {
  let lastText = "";
  const wrapped = (t: string): void => {
    if (t) lastText = t;
    onDelta(t);
  };
  const routes: Array<boolean | null> = p.local || p.backendProxy ? [null] : [null, getState().conf.proxyOn === false];
  let lastErr: unknown = null;
  for (const r of routes) {
    setRouteOverride(r);
    try {
      const result = await streamChat(p, model, history, wrapped, signal);
      setRouteOverride(null);
      return result;
    } catch (e) {
      if (e instanceof UserError || (e instanceof DOMException && e.name === "AbortError")) {
        setRouteOverride(null);
        throw e;
      }
      lastErr = e;
      if (lastText) {
        setRouteOverride(null);
        return { text: lastText };
      }
    }
  }
  setRouteOverride(null);
  throw lastErr instanceof Error ? lastErr : new Error("通信できませんでした");
}

/* ---------- 接続テスト・モデル一覧 ---------- */

function modelsRequest(p: ProviderDef): Promise<Response> {
  const key = effectiveToken(p.id);
  const base = effectiveBase(p.id);
  if (p.backendProxy && !base) return Promise.reject(missingBaseError(p));
  if (p.kind === "gemini") return apiFetch(`${p.base}/models?key=${encodeURIComponent(key)}`);
  if (p.kind === "anthropic") {
    return apiFetch(`${p.base}/models`, {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
  }
  if (p.kind === "cohere") {
    return apiFetch("https://api.cohere.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
  }
  if (p.kind === "github") {
    return apiFetch(p.modelsUrl || "", { headers: { Authorization: `Bearer ${key}` } });
  }
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  return apiFetch(`${base}/models`, { headers }, routeModeOf(p));
}

export async function testConnection(p: ProviderDef): Promise<TestResult> {
  const st = getState();
  const raw = (st.keys[p.id] || "").trim();
  if (p.backendProxy && !effectiveBase(p.id)) {
    return { ok: false, msg: "ベースURLが未入力です。対処：上の「ベースURL」欄に接続先URLを入力して保存してください。" };
  }
  if (!p.noKey && !raw && !isCustomId(p.id)) return { ok: false, msg: "キーが未入力です。上の欄にキーを貼ってください。" };
  if (p.id === "sambanova" && !proxyEnabled()) return { ok: false, msg: SAMBA_MSG };
  try {
    // 一覧APIがない会社は、その会社なりの確認方法で疎通を確かめる
    if (p.modelsMode === "none") {
      if (p.kind === "replicate") {
        const res = await apiFetch(`${p.base}/account`, { headers: { Authorization: `Bearer ${effectiveToken(p.id)}` } });
        if (res.ok) return okResult(p);
        return { ok: false, msg: friendlyError(res.status, await res.text(), p) };
      }
      if (p.kind === "vertex") {
        const r = await completeVertexOrGemini(p, p.defaultModel, [{ role: "user", content: "ping" }]);
        return r.text ? okResult(p) : { ok: false, msg: "応答が空でした。トークンの期限とプロジェクトIDを確認してください。" };
      }
      if (p.kind === "perplexity") {
        const r = await completeOpenAI(p, p.defaultModel, [{ role: "user", content: "ping" }]);
        return r.text ? okResult(p) : { ok: false, msg: "応答が空でした。" };
      }
      // alephalpha 等：一覧を試し、ダメなら未確認として正直に返す
      const res = await modelsRequest(p);
      if (res.ok) return okResult(p);
      return {
        ok: false,
        msg: `この会社の接続確認方法が確定できませんでした（一覧API応答 ${res.status}）。キーを保存し、実際に送信して確認してください。`,
      };
    }
    if (p.kind === "azure") {
      const endpoint = effectiveBase(p.id);
      const res = await apiFetch(`${endpoint}/openai/deployments?api-version=2024-10-21`, {
        headers: { "api-key": effectiveToken(p.id) },
      });
      if (res.ok) return okResult(p);
      return { ok: false, msg: friendlyError(res.status, await res.text(), p) };
    }
    if (p.kind === "bedrock") {
      const ids = await bedrockFoundationModels(p);
      return ids.length ? okResult(p) : { ok: false, msg: "基盤モデル一覧が空でした。リージョンと権限（bedrock:ListFoundationModels）を確認してください。" };
    }
    if (p.id === "ollama") {
      const tags = await ollamaTags(p);
      if (tags) return okResult(p);
    }
    const res = await modelsRequest(p);
    if (res.ok) return okResult(p);
    return { ok: false, msg: friendlyError(res.status, await res.text(), p) };
  } catch {
    return {
      ok: false,
      msg: p.local
        ? "接続先に届きませんでした。対処：ローカルサーバーが起動しているか、接続先URLが合っているか確認してください（スマホからは自宅PCの localhost に届きません）。"
        : p.backendProxy
          ? "接続先に届きませんでした。対処：ベースURLが正しいか、接続先サーバーが応答するか確認してください。"
          : "いま接続を確認できませんでした。対処：電波の良い場所でもう一度試してください。",
    };
  }
}

function okResult(p: ProviderDef): TestResult {
  const st = getState();
  update({ tested: { ...st.tested, [p.id]: true } });
  return { ok: true, msg: "接続できました。このキーでチャットできます。" };
}

async function ollamaTags(p: ProviderDef): Promise<string[] | null> {
  try {
    const base = effectiveBase(p.id).replace(/\/v1$/, "");
    const res = await fetch(`${base}/api/tags`);
    if (!res.ok) return null;
    const j = (await res.json()) as { models?: Array<{ name?: string }> };
    return (j.models || []).map((m) => m.name || "").filter(Boolean);
  } catch {
    return null;
  }
}

async function bedrockFoundationModels(p: ProviderDef): Promise<string[]> {
  const { accessKey, secret, region } = bedrockCreds(p);
  const url = `https://bedrock.${region}.amazonaws.com/foundation-models`;
  const { headers } = await signRequest({ method: "GET", url, body: "", accessKey, secret, region });
  const res = await fetchWithTimeout(url, { headers });
  if (!res.ok) await throwHttpError(res, p);
  const j = (await res.json()) as { modelSummaries?: Array<{ modelId?: string; outputModalities?: string[] }> };
  return (j.modelSummaries || [])
    .filter((m) => !m.outputModalities || m.outputModalities.includes("TEXT"))
    .map((m) => m.modelId || "")
    .filter(Boolean);
}

/** 自分のキーで実際に使えるモデル一覧を取得して保存する */
export async function fetchModels(p: ProviderDef): Promise<string[]> {
  const st = getState();
  const raw = (st.keys[p.id] || "").trim();
  if (p.backendProxy && !effectiveBase(p.id)) throw missingBaseError(p);
  if (!p.noKey && !raw && !isCustomId(p.id)) throw new UserError(`キーが未設定です。先に設定で${p.name}のキーを保存してください。`);
  if (p.id === "sambanova" && !proxyEnabled()) throw new Error(SAMBA_MSG);
  if (p.modelsMode === "none") {
    saveModelMeta(p, p.modelsNote || "一覧APIがないため初期値を表示しています");
    return p.models;
  }
  let ids: string[] = [];
  let rawFlags: Record<string, ModelFlag> = {};
  if (p.kind === "bedrock") {
    ids = await bedrockFoundationModels(p);
  } else if (p.kind === "azure") {
    const res = await apiFetch(`${effectiveBase(p.id)}/openai/deployments?api-version=2024-10-21`, {
      headers: { "api-key": effectiveToken(p.id) },
    });
    if (!res.ok) await throwHttpError(res, p);
    const j = (await res.json()) as { data?: Array<{ id?: string }> };
    ids = (j.data || []).map((d) => d.id || "").filter(Boolean);
  } else if (p.id === "ollama") {
    const tags = await ollamaTags(p);
    if (tags && tags.length) ids = tags;
    else {
      const res = await modelsRequest(p);
      if (!res.ok) await throwHttpError(res, p);
      const j = (await res.json()) as { data?: Array<{ id?: string }> };
      ids = (j.data || []).map((d) => d.id || "").filter(Boolean);
    }
  } else {
    const res = await modelsRequest(p);
    if (!res.ok) await throwHttpError(res, p);
    const j = (await res.json()) as unknown;
    const parsed = parseModelListWithFlags(p, j);
    ids = parsed.ids;
    rawFlags = parsed.flags;
  }
  ids = [...new Set(ids)].sort();
  if (!ids.length) throw new Error("モデル一覧が空でした。初期モデルのまま使ってください。");
  const cur = getState();
  const patch: Parameters<typeof update>[0] = {
    fetchedModels: { ...cur.fetchedModels, [p.id]: ids },
    tested: { ...cur.tested, [p.id]: true },
  };
  // 無料／通常の分類は、価格情報を持つ会社（カスタム・OpenRouter）だけ保存する
  if (isCustomId(p.id) || p.id === "openrouter") {
    const flags: Record<string, ModelFlag> = {};
    ids.forEach((id) => {
      flags[id] = rawFlags[id] ?? "paid";
    });
    patch.modelFlags = { ...cur.modelFlags, [p.id]: flags };
  }
  update(patch);
  saveModelMeta(p);
  return ids;
}

function saveModelMeta(p: ProviderDef, note?: string): void {
  const cur = getState();
  update({
    modelMeta: {
      ...cur.modelMeta,
      [p.id]: { fetchedAt: Date.now(), note: note || p.modelsNote },
    },
  });
}

/** 価格が 0 かどうか（"0" / "0.000000" / 0 をすべて 0 とみなす） */
function isZeroPrice(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n === 0;
}

interface RawModelItem {
  id?: string;
  name?: string;
  pricing?: { prompt?: unknown; completion?: unknown };
  price?: unknown;
  cost?: unknown;
}

/**
 * 1モデルの無料／通常を判定する。
 * 根拠：価格情報がすべて0（OpenRouter形式の pricing、または price/cost が数値0）、
 * またはモデルIDが :free で終わる・"free" を区切り文字つきで含む。
 */
export function classifyModel(item: RawModelItem): ModelFlag {
  const id = item.id || item.name || "";
  const pricing = item.pricing;
  if (pricing && isZeroPrice(pricing.prompt) && isZeroPrice(pricing.completion)) return "free";
  const flat = item.price ?? item.cost;
  if (typeof flat === "number" && flat === 0) return "free";
  if (id.endsWith(":free")) return "free";
  if (/(^|[/_-])free([/_-]|$)/i.test(id)) return "free";
  return "paid";
}

function parseModelListWithFlags(p: ProviderDef, j: unknown): { ids: string[]; flags: Record<string, ModelFlag> } {
  const flags: Record<string, ModelFlag> = {};
  const collect = (items: RawModelItem[]): void => {
    items.forEach((m) => {
      const id = m.id || m.name || "";
      if (id) flags[id] = classifyModel(m);
    });
  };
  const obj = j as { models?: Array<RawModelItem | string>; data?: Array<RawModelItem | string> };
  if (Array.isArray(j)) collect(j as RawModelItem[]);
  else collect([...(obj.data || []), ...(obj.models || [])].filter((m) => typeof m !== "string") as RawModelItem[]);
  return { ids: parseModelListRaw(p, j), flags };
}

function parseModelListRaw(p: ProviderDef, j: unknown): string[] {
  const obj = j as {
    models?: Array<{ id?: string; name?: string } | string>;
    data?: Array<{ id?: string; name?: string } | string>;
  };
  if (Array.isArray(j)) {
    return (j as Array<{ id?: string; name?: string }>)
      .map((m) => m.id || m.name || "")
      .filter(Boolean);
  }
  if (p.kind === "gemini") {
    return (obj.models || [])
      .map((m) => (typeof m === "string" ? m : m.name || "").replace(/^models\//, ""))
      .filter((id) => id && !id.includes("embedding") && !id.includes("aqa"));
  }
  let ids = (obj.data || obj.models || []).map((m) =>
    typeof m === "string" ? m : m.id || m.name || "",
  );
  ids = ids.filter(Boolean);
  if (p.id === "openai") ids = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id));
  return ids;
}
