import { findProvider} from "./providers";
import { getKeyFields, persistModelMeta, persistModels, persistTested, runtime, splitSavedKey, state} from "./state";
import type { Message, Provider, SourceLink, TestResult} from "./types";

/** HTTPステータスから、日本語＋対処法つきのエラー文を作る */
export function friendlyError(status: number, bodyText: string, p: Provider): string {
let detail = "";
try {
const j = JSON.parse(bodyText) as { error?: { message?: string}; message?: string};
detail = j.error?.message || j.message || "";
} catch {
detail = String(bodyText || "").slice(0, 160);
}
const tail = detail? `（詳細：${detail}）`: "";
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

async function fetchWithTimeout(url: string, opts: RequestInit, ms = 90000): Promise<Response> {
const ctl = new AbortController();
const timer = window.setTimeout(() => ctl.abort("timeout"), ms);
try {
return await apiFetch(url, {...opts, signal: runtime.abortCtl?.signal?? ctl.signal});
} catch (e) {
if (e instanceof DOMException && e.name === "AbortError") throw e;
throw new Error("通信できませんでした");
} finally {
window.clearTimeout(timer);
}
}

export const PROXY_URL = "https://eluntra.vercel.app/api/proxy";

export class UserError extends Error {}

let routeOverride: boolean | null = null;
export function setRouteOverride(v: boolean | null): void { routeOverride = v;}
export function proxyEnabled(): boolean { return routeOverride?? state.conf.proxyOn!== false;}

const SAMBA_PROXY_MSG =
"SambaNovaはブラウザから直接つなげないため、設定の「接続」で「サーバー経由で接続」をオンにしてください。オンにすると中継サーバー経由で使えます。";

function isLocalUrl(url: string): boolean {
try {
const h = new URL(url).hostname;
return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
} catch { return false;}
}

/** 経由がオンなら中継サーバーへ、オフなら各社へ直接。ローカルAIは常に対象外（直接接続） */
export async function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
if (isLocalUrl(url) ||!proxyEnabled()) return fetch(url, opts);
const headers = new Headers(opts?.headers);
headers.set("x-target-url", url);
return fetch(PROXY_URL, {...opts, headers});
}

/** 会社ごとの実効ベースURL（Cloudflare/Azure/Bedrock/Vertex/ローカルを解決） */
export function effBase(p: Provider, key: string): string {
if (p.id === "cloudflare") return p.base.replace("{account}", splitSavedKey(p.id, key).acct);
if (p.type === "azure") return (getKeyFields(p.id).endpoint || "").replace(/\/$/, "");
if (p.type === "bedrock") {
const region = (getKeyFields(p.id).region || "us-east-1").trim();
return `https://bedrock-runtime.${region}.amazonaws.com`;
}
if (p.local) {
const base = (getKeyFields(p.id).base || "").trim();
return (base || p.base).replace(/\/$/, "");
}
return p.base;
}
export function effToken(p: Provider, key: string): string {
if (p.id === "cloudflare") return splitSavedKey(p.id, key).token;
if (p.type === "azure") return getKeyFields(p.id).key || "";
if (p.type === "vertex") return getKeyFields(p.id).token || "";
if (p.local) return "";
return key;
}

function bearer(p: Provider, key: string): Record<string, string> {
return { Authorization: `Bearer ${effToken(p, key)}`};
}

/* ---------- 思考レベル（effort）を実リクエストへ反映 ---------- */

/** 全社共通：システム指示の補強（非対応プロバイダーでも最低限これが効く） */
export function effortSystem(base: string): string {
const e = state.conf.effort;
const note =
e === "low"? "簡潔に、要点だけを答えてください。"
: e === "high"? "段階的に考え、最後に自分の答えを簡潔に自己検証してから答えてください。"
: e === "super"? "段階的に深く考え、多角的に検討し、自己検証してから、完成度の高い答えを返してください。"
: "";
return [base, note].filter(Boolean).join("\n");
}

/** OpenAI互換で reasoning_effort を渡せることが知られている範囲だけ渡す */
function reasoningEffort(p: Provider, model: string): string | undefined {
const e = state.conf.effort;
if (e === "medium") return undefined;
const val = e === "low"? "low": "high";
if (p.id === "openai" && /^(o\d|gpt-5)/.test(model)) return val;
if (p.id === "xai" && /(grok-3-mini|grok-4)/.test(model)) return val;
if (p.id === "openrouter" && /(o\d|reason|gpt-5)/i.test(model)) return val;
return undefined;
}

/* ---------- 添付の正規化 ---------- */

const IMAGE_PROVIDERS = new Set(["openai", "gemini", "anthropic", "openrouter", "xai", "perplexity", "githubmodels", "vertex", "azure"]);
export function providerSupportsImage(p: Provider): boolean {
return IMAGE_PROVIDERS.has(p.id) && p.type!== "replicate" && p.type!== "bedrock";
}
export function historyHasImage(history: Message[]): boolean {
return history.some((m) => (m.attachments || []).some((a) => a.kind === "image"));
}

/** テキスト添付は本文へ畳み込み、画像は各社の形式に合わせて別途取り出す */
function plainText(m: Message): string {
const texts = (m.attachments || []).filter((a) => a.kind === "text" && a.text);
let c = m.content;
for (const t of texts) c += `\n\n\n${t.text}`;
return c;
}
function imagesOf(m: Message): Array<{ dataUrl: string; mime: string; data: string}> {
return (m.attachments || [])
.filter((a) => a.kind === "image" && a.dataUrl)
.map((a) => ({
dataUrl: a.dataUrl as string,
mime: a.mime || "image/png",
data: (a.dataUrl as string).split(",")[1] || "",
}));
}

/* ---------- モデル一覧・接続テスト ---------- */

function modelsRequest(p: Provider, key: string): Promise<Response> {
if (p.type === "gemini") return apiFetch(`${p.base}/models?key=${encodeURIComponent(key)}`);
if (p.type === "anthropic") {
return apiFetch(`${p.base}/models`, {
headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
});
}
if (p.type === "cohere") return apiFetch("https://api.cohere.com/v1/models", { headers: bearer(p, key)});
if (p.type === "replicate") return apiFetch(`${p.base}/account`, { headers: bearer(p, key)});
if (p.modelsUrl) return apiFetch(p.modelsUrl, { headers: bearer(p, key)});
return apiFetch(`${effBase(p, key)}${p.modelsPath && p.modelsPath!== "none"? p.modelsPath: "/models"}`, { headers: bearer(p, key)});
}

async function testLocal(p: Provider): Promise<TestResult> {
const base = effBase(p, "");
try {
const res = await fetch(`${base}/models`);
if (res.ok) { state.tested[p.id] = true; persistTested(); return { ok: true, msg: "接続できました。ローカルサーバーに応答があります。"};}
if (p.id === "ollama") {
const root = base.replace(/\/v1$/, "");
const r2 = await fetch(`${root}/api/tags`);
if (r2.ok) { state.tested[p.id] = true; persistTested(); return { ok: true, msg: "接続できました（/api/tags で確認）。"};}
}
return { ok: false, msg: `ローカルサーバーから応答がありませんでした（HTTP ${res.status}）。対処：${p.name}を起動し、ベースURLを確認してください。スマホからは自分のPCのlocalhostには届きません。`};
} catch {
return { ok: false, msg: `ローカルサーバーへ接続できませんでした。対処：${p.name}が起動しているか、ベースURLが正しいかを確認してください。スマホからは自分のPCのlocalhostには届きません（同一端末／同一ネットワークで到達できる場合のみ使えます）。`};
}
}

export async function testConnection(pid: string): Promise<TestResult> {
const p = findProvider(pid);
const key = (state.keys[pid] || "").trim();
if (p.local) return testLocal(p);
if (!p.noKey &&!key) return { ok: false, msg: "キーが未入力です。上の欄にキーを貼ってください。"};
if (pid === "sambanova" &&!proxyEnabled()) return { ok: false, msg: SAMBA_PROXY_MSG};
try {
if (p.type === "bedrock") {
const ids = await bedrockListModels(p);
state.tested[pid] = true; persistTested();
return { ok: true, msg: `接続できました（基盤モデル ${ids.length} 件を確認）。`};
}
if (p.type === "azure") {
const res = await apiFetch(`${effBase(p, key)}/openai/deployments?api-version=2024-10-21`, { headers: { "api-key": effToken(p, key)}});
if (res.ok) { state.tested[pid] = true; persistTested(); return { ok: true, msg: "接続できました。デプロイ一覧を取得できました。"};}
return { ok: false, msg: friendlyError(res.status, await res.text(), p)};
}
if (p.type === "vertex") {
const f = getKeyFields(pid);
const loc = (f.location || "us-central1").trim();
const res = await apiFetch(`https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent((f.project || "").trim())}/locations/${encodeURIComponent(loc)}`, { headers: bearer(p, key)});
if (res.ok) { state.tested[pid] = true; persistTested(); return { ok: true, msg: "接続できました（トークンとプロジェクトを確認）。トークンは約1時間で失効します。"};}
const t = await res.text();
return { ok: false, msg: res.status === 401 || res.status === 403? "トークンが無効か失効しています。対処：新しいアクセストークンを取得して貼り直してください（約1時間で失効します）。" + (t? `（詳細：${t.slice(0, 120)}）`: ""): friendlyError(res.status, t, p)};
}
if (pid === "perplexity") {
// 一覧APIが無いので、最小のチャット送信で疎通を確認する
const res = await apiFetch(`${p.base}/chat/completions`, {
method: "POST", headers: { "Content-Type": "application/json",...bearer(p, key)},
body: JSON.stringify({ model: p.def, messages: [{ role: "user", content: "ping"}], max_tokens: 1}),
});
if (res.ok) { state.tested[pid] = true; persistTested(); return { ok: true, msg: "接続できました（最小のリクエストで確認）。"};}
return { ok: false, msg: friendlyError(res.status, await res.text(), p)};
}
const res = await modelsRequest(p, key);
if (res.ok) {
state.tested[pid] = true; persistTested();
return { ok: true, msg: "接続できました。このキーでチャットできます。"};
}
const t = await res.text();
delete state.tested[pid]; persistTested();
if (pid === "ai21" && res.status === 404) {
return { ok: false, msg: "AI21にはモデル一覧APIが確認できないため、接続テストでは確認できませんでした。対処：そのままチャットを送って確認してください（モデルは jamba-large / jamba-mini が初期値です）。"};
}
return { ok: false, msg: friendlyError(res.status, t, p)};
} catch {
if (pid === "sambanova") return { ok: false, msg: "中継サーバー経由でもSambaNovaへ通信できませんでした。対処：電波を確認し、少し待ってからもう一度試してください。"};
if (p.type === "bedrock") return { ok: false, msg: "Bedrockへ通信できませんでした。考えられる理由：ブラウザ／中継のCORS制限、SigV4署名の不一致、IAM権限不足のいずれかです。対処：アクセスキー・リージョンと、Bedrockのモデルアクセス許可を確認してください。"};
return { ok: false, msg: "いま接続を確認できませんでした。対処：電波の良い場所でもう一度試してください。"};
}
}

function setMeta(pid: string, note?: string): void {
state.modelMeta[pid] = { fetchedAt: Date.now(), note};
persistModelMeta();
}

/** 自分のキーで実際に使えるモデル一覧を取得して保存する */
export async function fetchModels(pid: string): Promise<string[]> {
const p = findProvider(pid);
const key = (state.keys[pid] || "").trim();
if (!p.noKey &&!p.local &&!key) throw new Error(`キーが未設定です。先に設定で${p.name}のキーを保存してください。`);
if (pid === "sambanova" &&!proxyEnabled()) throw new Error(SAMBA_PROXY_MSG);
// 一覧APIが無い会社：初期値を返し、その旨を明示する（架空の補完はしない）
if (p.modelsPath === "none" || p.type === "vertex") {
setMeta(pid, p.modelsNote || "一覧APIがないため初期値を表示しています");
return [...p.models];
}
if (p.type === "replicate") {
const res = await modelsRequest(p, key);
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
setMeta(pid, p.modelsNote);
return [...p.models];
}
if (p.type === "bedrock") {
const ids = await bedrockListModels(p);
if (!ids.length) throw new Error("モデル一覧が空でした。リージョンとIAM権限を確認してください。");
state.fetchedModels[pid] = ids; persistModels(); setMeta(pid);
state.tested[pid] = true; persistTested();
return ids;
}
if (p.type === "azure") {
const res = await apiFetch(`${effBase(p, key)}/openai/deployments?api-version=2024-10-21`, { headers: { "api-key": effToken(p, key)}});
if (!res.ok) { setMeta(pid, "デプロイ一覧を取得できなかったため初期値を表示しています"); return [...p.models];}
const j = (await res.json()) as { data?: Array<{ id?: string}>};
const ids = (j.data || []).map((d) => d.id || "").filter(Boolean);
if (ids.length) { state.fetchedModels[pid] = ids; persistModels();}
setMeta(pid, ids.length? undefined: "デプロイが見つからなかったため初期値を表示しています");
return ids.length? ids: [...p.models];
}
if (p.local && p.id === "ollama") {
try {
const res = await fetch(`${effBase(p, key)}/models`);
if (res.ok) {
const j = (await res.json()) as { data?: Array<{ id?: string}>};
const ids = (j.data || []).map((d) => d.id || "").filter(Boolean);
if (ids.length) { state.fetchedModels[pid] = ids; persistModels(); setMeta(pid); state.tested[pid] = true; persistTested(); return ids;}
}
} catch { /* tagsへフォールバック */}
const root = effBase(p, key).replace(/\/v1$/, "");
const r2 = await fetch(`${root}/api/tags`);
if (!r2.ok) throw new Error("Ollamaへ接続できませんでした。起動とベースURLを確認してください。");
const j2 = (await r2.json()) as { models?: Array<{ name?: string}>};
const ids = (j2.models || []).map((m) => m.name || "").filter(Boolean);
if (!ids.length) throw new Error("導入済みモデルがありませんでした。ollama pull でモデルを取得してください。");
state.fetchedModels[pid] = ids; persistModels(); setMeta(pid);
state.tested[pid] = true; persistTested();
return ids;
}
const res = await modelsRequest(p, key);
if (!res.ok) {
if (pid === "ai21") { setMeta(pid, p.modelsNote); return [...p.models];}
throw new UserError(friendlyError(res.status, await res.text(), p));
}
let j: unknown;
try { j = await res.json(); } catch {
  if (pid === "githubmodels" || pid === "ai21") { setMeta(pid, "一覧の形式を確認できなかったため初期値を表示しています"); return [...p.models]; }
  throw new Error("モデル一覧の形式が想定と違いました。標準モデルのまま使ってください。");
}
let ids: string[] = [];
if (p.type === "gemini") {
const jj = j as { models?: Array<{ name?: string} | string>};
ids = (jj.models || []).map((m) => (typeof m === "string"? m: m.name || "").replace(/^models\//, "")).filter((id) => id &&!id.includes("embedding") &&!id.includes("aqa"));
} else if (Array.isArray(j)) {
// GitHub Modelsカタログ等：配列そのものが返る形式を防御的にパース
ids = (j as Array<{ id?: string; name?: string} | string>).map((m) => (typeof m === "string"? m: m.id || m.name || "")).filter(Boolean);
} else {
const jj = j as { data?: Array<{ id?: string; name?: string} | string>; models?: Array<{ id?: string; name?: string} | string>};
ids = (jj.data || jj.models || []).map((m) => (typeof m === "string"? m: m.id || m.name || "")).filter(Boolean);
}
if (pid === "openai") ids = ids.filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id));
ids = [...new Set(ids)].sort();
if (!ids.length) {
  if (pid === "ai21" || pid === "githubmodels") { setMeta(pid, p.modelsNote || "一覧が空だったため初期値を表示しています"); return [...p.models]; }
  throw new Error("モデル一覧が空でした。標準モデルのまま使ってください。");
}
state.fetchedModels[pid] = ids;
persistModels(); setMeta(pid);
state.tested[pid] = true; persistTested();
return ids;
}

/* ---------- チャット送信 ---------- */

type OnDelta = (full: string) => void;
export interface ChatOpts { onSources?: (s: SourceLink[]) => void}

async function readSse(res: Response, pick: (json: never) => string): Promise<string> {
if (!res.body) throw new Error("応答の読み取りに失敗しました。対処：もう一度送ってください。");
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = ""; let full = "";
for (;;) {
const { done, value} = await reader.read();
if (done) break;
buf += dec.decode(value, { stream: true});
const lines = buf.split("\n");
buf = lines.pop()?? "";
for (const line of lines) {
const t = line.trim();
if (!t.startsWith("data:")) continue;
const d = t.slice(5).trim();
if (!d || d === "[DONE]") continue;
try {
const txt = pick(JSON.parse(d) as never);
if (txt) full += txt;
} catch { /* 途中行は無視 */}
}
}
return full;
}

function mergedHistory(history: Message[]): Message[] {
const out: Message[] = [];
for (const m of history) {
const last = out[out.length - 1];
if (last && last.role === m.role) last.content = last.content + "\n\n" + m.content;
else out.push({...m});
}
return out;
}

/** OpenAI互換（大半の会社） */
export async function callOpenAI(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const useImg = providerSupportsImage(p);
const msgs: Array<{ role: string; content: unknown}> = [];
const sys = effortSystem(state.conf.system);
if (sys) msgs.push({ role: "system", content: sys});
history.forEach((m) => {
const imgs = useImg? imagesOf(m): [];
if (m.role === "user" && imgs.length) {
msgs.push({ role: m.role, content: [{ type: "text", text: plainText(m)},...imgs.map((im) => ({ type: "image_url", image_url: { url: im.dataUrl}}))]});
} else {
msgs.push({ role: m.role, content: plainText(m)});
}
});
const body: Record<string, unknown> = { model, messages: msgs, temperature: state.conf.temp, stream: true};
const re = reasoningEffort(p, model);
if (re) body.reasoning_effort = re;
const res = await fetchWithTimeout(`${effBase(p, key)}${p.chatPath || "/chat/completions"}`, {
method: "POST",
headers: { "Content-Type": "application/json",...bearer(p, key)},
body: JSON.stringify(body),
});
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
let full = "";
full = await readSse(res, (j: { choices?: Array<{ delta?: { content?: string}}>}) => {
const delta = j.choices?.[0]?.delta?.content || "";
if (delta) { full += delta; onDelta(full);}
return delta;
});
return full;
}

/** Perplexity：citations を出典として付ける（非ストリーミングで確実に受け取る） */
async function callPerplexity(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta, opts?: ChatOpts): Promise<string> {
const msgs: Array<{ role: string; content: string}> = [];
const sys = effortSystem(state.conf.system);
if (sys) msgs.push({ role: "system", content: sys});
history.forEach((m) => msgs.push({ role: m.role, content: plainText(m)}));
const res = await fetchWithTimeout(`${p.base}${p.chatPath || "/chat/completions"}`, {
method: "POST", headers: { "Content-Type": "application/json",...bearer(p, key)},
body: JSON.stringify({ model, messages: msgs, temperature: state.conf.temp}),
});
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
const j = (await res.json()) as { choices?: Array<{ message?: { content?: string}}>; citations?: string[]};
let full = j.choices?.[0]?.message?.content || "";
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
const cites = (j.citations || []).filter((c) => /^https?:\/\//.test(c));
if (cites.length) {
const sources = cites.map((url) => { try { return { title: new URL(url).hostname, url};} catch { return { title: url, url};}});
opts?.onSources?.(sources);
full += "\n\n出典:\n" + cites.map((c) => `- ${c}`).join("\n");
}
onDelta(full);
return full;
}

/** Azure OpenAI：デプロイ名＝モデル名、api-keyヘッダー */
async function callAzure(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const endpoint = effBase(p, key);
if (!endpoint) throw new UserError("エンドポイントURLが未設定です。対処：設定でAzureのエンドポイントURLを保存してください。");
const msgs: Array<{ role: string; content: unknown}> = [];
const sys = effortSystem(state.conf.system);
if (sys) msgs.push({ role: "system", content: sys});
history.forEach((m) => {
const imgs = imagesOf(m);
if (m.role === "user" && imgs.length) msgs.push({ role: m.role, content: [{ type: "text", text: plainText(m)},...imgs.map((im) => ({ type: "image_url", image_url: { url: im.dataUrl}}))]});
else msgs.push({ role: m.role, content: plainText(m)});
});
const url = `${endpoint}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=2024-10-21`;
const res = await fetchWithTimeout(url, {
method: "POST", headers: { "Content-Type": "application/json", "api-key": effToken(p, key)},
body: JSON.stringify({ messages: msgs, temperature: state.conf.temp, stream: true}),
});
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
let full = "";
full = await readSse(res, (j: { choices?: Array<{ delta?: { content?: string}}>}) => {
const delta = j.choices?.[0]?.delta?.content || "";
if (delta) { full += delta; onDelta(full);}
return delta;
});
return full;
}

/** Google Gemini */
export async function callGemini(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const contents = mergedHistory(history).map((m) => {
const parts: Array<Record<string, unknown>> = [{ text: plainText(m)}];
if (m.role === "user") for (const im of imagesOf(m)) parts.push({ inlineData: { mimeType: im.mime, data: im.data}});
return { role: m.role === "assistant"? "model": "user", parts};
});
const gen: Record<string, unknown> = { temperature: state.conf.temp};
if (model.includes("2.5")) {
const e = state.conf.effort;
if (e === "low") gen.thinkingConfig = { thinkingBudget: 0};
else if (e === "high") gen.thinkingConfig = { thinkingBudget: 4096};
else if (e === "super") gen.thinkingConfig = { thinkingBudget: 12000};
}
const body: Record<string, unknown> = { contents, generationConfig: gen};
const sys = effortSystem(state.conf.system);
if (sys) body.systemInstruction = { parts: [{ text: sys}]};
const url = `${p.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
const res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json"}, body: JSON.stringify(body)});
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
let full = "";
full = await readSse(res, (j: { candidates?: Array<{ content?: { parts?: Array<{ text?: string}>}}>}) => {
const txt = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
if (txt) { full += txt; onDelta(full);}
return txt;
});
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
return full;
}

/** Vertex AI：Gemini形式・非ストリーミング・Bearerトークン */
async function callVertex(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const f = getKeyFields(p.id);
const project = (f.project || "").trim();
const loc = (f.location || "us-central1").trim();
if (!project) throw new UserError("プロジェクトIDが未設定です。対処：設定でVertex AIのプロジェクトIDを保存してください。");
const contents = mergedHistory(history).map((m) => {
const parts: Array<Record<string, unknown>> = [{ text: plainText(m)}];
if (m.role === "user") for (const im of imagesOf(m)) parts.push({ inlineData: { mimeType: im.mime, data: im.data}});
return { role: m.role === "assistant"? "model": "user", parts};
});
const gen: Record<string, unknown> = { temperature: state.conf.temp};
if (model.includes("2.5")) {
const e = state.conf.effort;
if (e === "low") gen.thinkingConfig = { thinkingBudget: 0};
else if (e === "high") gen.thinkingConfig = { thinkingBudget: 4096};
else if (e === "super") gen.thinkingConfig = { thinkingBudget: 12000};
}
const body: Record<string, unknown> = { contents, generationConfig: gen};
const sys = effortSystem(state.conf.system);
if (sys) body.systemInstruction = { parts: [{ text: sys}]};
const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
const res = await fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json",...bearer(p, key)}, body: JSON.stringify(body)});
if (!res.ok) {
const t = await res.text();
if (res.status === 401 || res.status === 403) throw new UserError("トークンが無効か失効しています。対処：新しいアクセストークンを取得して貼り直してください（約1時間で失効します）。");
throw new UserError(friendlyError(res.status, t, p));
}
const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string}>}}>};
const full = (j.candidates?.[0]?.content?.parts || []).map((x) => x.text || "").join("");
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
onDelta(full);
return full;
}

/** Anthropic */
export async function callAnthropic(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const msgs = mergedHistory(history).map((m) => {
const imgs = m.role === "user"? imagesOf(m): [];
if (imgs.length) {
return { role: m.role, content: [{ type: "text", text: plainText(m)},...imgs.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mime, data: im.data}}))]};
}
return { role: m.role, content: plainText(m)};
});
const e = state.conf.effort;
const thinkingOk = (e === "high" || e === "super") && /(claude-3-7|claude-sonnet-4|claude-opus-4)/.test(model);
const budget = e === "super"? 10000: 4000;
const body: Record<string, unknown> = { model, max_tokens: thinkingOk? budget + 4096: 4096, messages: msgs};
if (thinkingOk) body.thinking = { type: "enabled", budget_tokens: budget};
else body.temperature = state.conf.temp;
const sys = effortSystem(state.conf.system);
if (sys) body.system = sys;
const res = await fetchWithTimeout(`${p.base}/messages`, {
method: "POST",
headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true"},
body: JSON.stringify(body),
});
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
const j = (await res.json()) as { content?: Array<{ text?: string}>};
const full = (j.content || []).map((c) => c.text || "").join("");
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
onDelta(full);
return full;
}

/** Cohere */
export async function callCohere(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const msgs = history.map((m) => ({ role: m.role, content: plainText(m)}));
const sys = effortSystem(state.conf.system);
const body = { model, messages: sys? [{ role: "system", content: sys},...msgs]: msgs, temperature: state.conf.temp};
const res = await fetchWithTimeout(`${p.base}/v2/chat`, {
method: "POST", headers: { "Content-Type": "application/json",...bearer(p, key)}, body: JSON.stringify(body),
});
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
const j = (await res.json()) as { message?: { content?: Array<{ text?: string}>}};
const full = (j.message?.content || []).map((c) => c.text || "").join("");
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
onDelta(full);
return full;
}

/** Replicate：公式モデルの Predictions API（Prefer: wait、非ストリーミング） */
async function callReplicate(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
const sys = effortSystem(state.conf.system);
const lastUser = [...history].reverse().find((m) => m.role === "user");
const prior = history.slice(0, history.lastIndexOf(lastUser?? history[history.length - 1]))
.map((m) => `${m.role === "user"? "User": "Assistant"}: ${plainText(m)}`).join("\n");
const input: Record<string, unknown> = {
prompt: (prior? prior + "\n": "") + `User: ${lastUser? plainText(lastUser): ""}\nAssistant:`,
max_tokens: state.conf.effort === "low"? 1024: 4096,
};
if (sys) input.system_prompt = sys;
const url = `${p.base}/models/${model}/predictions`;
let res = await fetchWithTimeout(url, {
method: "POST", headers: { "Content-Type": "application/json", Prefer: "wait",...bearer(p, key)},
body: JSON.stringify({ input}),
}, 120000);
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
let j = (await res.json()) as { status?: string; output?: unknown; urls?: { get?: string}; error?: string};
let tries = 0;
while ((j.status === "starting" || j.status === "processing") && j.urls?.get && tries < 20) {
tries++;
await new Promise((r) => setTimeout(r, 3000));
res = await fetchWithTimeout(j.urls.get, { headers: bearer(p, key)}, 30000);
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
j = (await res.json()) as typeof j;
}
if (j.status === "failed") throw new Error(`Replicateで生成に失敗しました${j.error? `（${String(j.error).slice(0, 120)}）`: ""}。対処：モデルを変えるか、もう一度送ってください。`);
const out = j.output;
const full = typeof out === "string"? out: Array.isArray(out)? out.map((x) => String(x)).join(""): "";
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
onDelta(full);
return full;
}

/* ---------- Amazon Bedrock（SigV4署名をWebCryptoで自前実装） ---------- */

async function hmac(keyData: BufferSource, msg: string): Promise<ArrayBuffer> {
const k = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}
async function sha256Hex(text: string): Promise<string> {
const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexOf(buf: ArrayBuffer): string {
return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function bedrockFetch(p: Provider, method: string, urlStr: string, bodyText = ""): Promise<Response> {
const f = getKeyFields(p.id);
const access = (f.accessKey || "").trim();
const secret = (f.secret || "").trim();
const region = (f.region || "us-east-1").trim();
if (!access ||!secret) throw new UserError("アクセスキーIDとシークレットキーを保存してください。対処：設定のAmazon Bedrockで3欄すべてを入力してください。");
const url = new URL(urlStr);
const service = url.hostname.startsWith("bedrock-runtime")? "bedrock": "bedrock";
const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
const dateStamp = amzDate.slice(0, 8);
const payloadHash = await sha256Hex(bodyText);
const headers: Record<string, string> = {
host: url.hostname,
"x-amz-date": amzDate,
"x-amz-content-sha256": payloadHash,
};
if (bodyText) headers["content-type"] = "application/json";
const signedNames = Object.keys(headers).sort();
const canonicalHeaders = signedNames.map((n) => `${n}:${headers[n]}\n`).join("");
const canonical = [method, url.pathname, url.search? url.search.slice(1): "", canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");
const scope = `${dateStamp}/${region}/${service}/aws4_request`;
const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonical)].join("\n");
let k: ArrayBuffer = await hmac(new TextEncoder().encode("AWS4" + secret), dateStamp);
k = await hmac(k, region);
k = await hmac(k, service);
k = await hmac(k, "aws4_request");
const sig = hexOf(await hmac(k, stringToSign));
headers["Authorization"] = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${sig}`;
return apiFetch(urlStr, { method, headers, body: bodyText || undefined});
}

async function bedrockListModels(p: Provider): Promise<string[]> {
const region = (getKeyFields(p.id).region || "us-east-1").trim();
const res = await bedrockFetch(p, "GET", `https://bedrock.${region}.amazonaws.com/foundation-models`);
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
const j = (await res.json()) as { modelSummaries?: Array<{ modelId?: string}>};
return (j.modelSummaries || []).map((m) => m.modelId || "").filter(Boolean).sort();
}

async function callBedrock(p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta): Promise<string> {
void key;
const msgs = mergedHistory(history).map((m) => ({ role: m.role, content: [{ text: plainText(m)}]}));
if (msgs.length && msgs[0].role!== "user") msgs.unshift({ role: "user", content: [{ text: "（続き）"}]});
const body: Record<string, unknown> = {
messages: msgs,
inferenceConfig: { temperature: state.conf.temp, maxTokens: state.conf.effort === "low"? 1024: 4096},
};
const sys = effortSystem(state.conf.system);
if (sys) body.system = [{ text: sys}];
const region = (getKeyFields(p.id).region || "us-east-1").trim();
const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
let res: Response;
try {
res = await bedrockFetch(p, "POST", url, JSON.stringify(body));
} catch (e) {
if (e instanceof UserError) throw e;
throw new Error("Bedrockへ通信できませんでした。考えられる理由：CORS制限・署名の不一致・IAM権限不足です。対処：キーとリージョン、Bedrockのモデルアクセス許可を確認してください。");
}
if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), p));
const j = (await res.json()) as { output?: { message?: { content?: Array<{ text?: string}>}}};
const full = (j.output?.message?.content || []).map((c) => c.text || "").join("");
if (!full) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
onDelta(full);
return full;
}

/* ---------- 送信の自動リカバリ（v4.11の方針を維持） ---------- */

export async function callWithFallback(
p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta, opts?: ChatOpts,
): Promise<string> {
// ローカルAIと署名つきBedrockは経路切替の対象外（直接のみ）
if (p.local) return callChat(p, key, model, history, onDelta, opts);
let lastText = "";
const wrapped = (t: string): void => { if (t) lastText = t; onDelta(t);};
const routes: Array<boolean | null> = [null, state.conf.proxyOn === false];
let lastErr: unknown = null;
for (const r of routes) {
setRouteOverride(r);
try {
const text = await callChat(p, key, model, history, wrapped, opts);
setRouteOverride(null);
return text;
} catch (e) {
if (e instanceof UserError || (e instanceof DOMException && e.name === "AbortError")) {
setRouteOverride(null);
throw e;
}
lastErr = e;
if (lastText) { setRouteOverride(null); return lastText;}
}
}
setRouteOverride(null);
throw lastErr instanceof Error? lastErr: new Error("通信できませんでした");
}

export function callChat(
p: Provider, key: string, model: string, history: Message[], onDelta: OnDelta, opts?: ChatOpts,
): Promise<string> {
if (p.id === "sambanova" &&!proxyEnabled()) throw new Error(SAMBA_PROXY_MSG);
if (p.id === "perplexity") return callPerplexity(p, key, model, history, onDelta, opts);
switch (p.type) {
case "gemini": return callGemini(p, key, model, history, onDelta);
case "anthropic": return callAnthropic(p, key, model, history, onDelta);
case "cohere": return callCohere(p, key, model, history, onDelta);
case "replicate": return callReplicate(p, key, model, history, onDelta);
case "bedrock": return callBedrock(p, key, model, history, onDelta);
case "azure": return callAzure(p, key, model, history, onDelta);
case "vertex": return callVertex(p, key, model, history, onDelta);
default: return callOpenAI(p, key, model, history, onDelta);
}
}
