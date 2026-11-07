import { apiFetch, effBase, effToken, friendlyError } from "./api";
import { isLoggedIn, pushSync} from "./auth";
import { persistNotes, runtime, state} from "./state";
import type { Message, Provider} from "./types";
import { uid} from "./util";

/**
* エージェント実行エンジン。
* モデルがツール（コード実行・日時・ページ取得・メモ保存/検索）を自分で選んで実行し、
* 結果を見て次の手順を決めるループを回す。通常チャットとは別経路（非ストリーミング）。
*/

const MAX_STEPS = 8;
const AGENT_SYS =
"あなたはEluntraのエージェントです。必要に応じてツールを使い、段階的にタスクを完了してください。" +
"計算やコードで確かめられることは推測で答えず、実際にツールで確認してください。" +
"ツールが不要な質問にはそのまま答えてください。最後に、結果をまとめた最終回答を書いてください。";

interface ToolDef {
name: string;
label: string;
description: string;
parameters: Record<string, unknown>;
}

const TOOL_DEFS: ToolDef[] = [
{
name: "run_javascript",
label: "コードを実行",
description: "JavaScriptコードを隔離されたサンドボックスで実行し、console.logの出力と戻り値を返す。計算・データ処理・検証に使う。",
parameters: {
type: "object",
properties: { code: { type: "string", description: "実行するJavaScriptコード"}},
required: ["code"],
},
},
{
name: "get_current_datetime",
label: "日時を確認",
description: "現在の日時（日本時間）を返す。",
parameters: { type: "object", properties: {}},
},
{
name: "fetch_url",
label: "ページを取得",
description: "指定URLのページ本文テキストを取得する。CORSで取得できないサイトもある。",
parameters: {
type: "object",
properties: { url: { type: "string", description: "取得するURL"}},
required: ["url"],
},
},
{
name: "save_note",
label: "メモを保存",
description: "調べた結果や要約をメモとして保存する。保存したメモはユーザーの端末とSupabase（ログイン時）に残る。",
parameters: {
type: "object",
properties: {
title: { type: "string", description: "メモのタイトル"},
content: { type: "string", description: "メモの本文"},
},
required: ["title", "content"],
},
},
{
name: "search_notes",
label: "メモを検索",
description: "保存済みメモをキーワードで検索する。",
parameters: {
type: "object",
properties: { query: { type: "string", description: "検索キーワード"}},
required: ["query"],
},
},
];

function toolLabel(name: string): string {
return TOOL_DEFS.find((t) => t.name === name)?.label?? name;
}

/* ---------- ツールの実行 ---------- */

/** 隔離iframe（sandbox属性、同一オリジン不許可）でJSを実行する */
export function runSandboxedJs(code: string): Promise<string> {
return new Promise((resolve) => {
const id = Math.random().toString(36).slice(2);
const iframe = document.createElement("iframe");
iframe.setAttribute("sandbox", "allow-scripts");
iframe.style.display = "none";
let done = false;
const finish = (out: string): void => {
if (done) return;
done = true;
window.clearTimeout(timer);
window.removeEventListener("message", onMsg);
iframe.remove();
resolve(out.slice(0, 4000));
};
const onMsg = (e: MessageEvent): void => {
const d = e.data as { __eluntra?: string; out?: string} | null;
if (d && d.__eluntra === id) finish(String(d.out?? ""));
};
const timer = window.setTimeout(() => finish("（6秒で時間切れになりました）"), 6000);
window.addEventListener("message", onMsg);
const src =
"<!DOCTYPE html><script>" +
"var logs=[];function fmt(v){try{return typeof v==='string'?v:JSON.stringify(v)}catch(e){return String(v)}}" +
"console.log=function(){logs.push([].map.call(arguments,fmt).join(' '))};console.error=console.warn=console.log;" +
"window.addEventListener('error',function(e){parent.postMessage({__eluntra:'" + id + "',out:'エラー: '+e.message},'*')});" +
"(async function(){try{var r=await (async function(){" + code + "\n})();" +
"var out=logs.join('\\n');if(r!==undefined)out+=(out?'\\n':'')+'戻り値: '+fmt(r);" +
"parent.postMessage({__eluntra:'" + id + "',out:out||'（出力なし）'},'*')" +
"}catch(err){parent.postMessage({__eluntra:'" + id + "',out:'エラー: '+((err&&err.message)||err)},'*')}})();" +
"<\/script>";
iframe.srcdoc = src;
document.body.appendChild(iframe);
});
}

async function executeTool(
name: string,
args: Record<string, unknown>,
): Promise<string> {
try {
switch (name) {
case "run_javascript":
return await runSandboxedJs(String(args.code || ""));
case "get_current_datetime": {
const now = new Date();
const jst = new Intl.DateTimeFormat("ja-JP", {
timeZone: "Asia/Tokyo",
year: "numeric", month: "long", day: "numeric",
weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).format(now);
return `現在の日時（日本時間）: ${jst}`;
}
case "fetch_url": {
const url = String(args.url || "");
if (!/^https?:\/\//.test(url)) return "URLが正しくありません。http:// または https:// で始まるURLを指定してください。";
const ctl = new AbortController();
const t = window.setTimeout(() => ctl.abort(), 15000);
try {
const res = await fetch(url, { signal: ctl.signal});
if (!res.ok) return `取得できませんでした（HTTP ${res.status}）。`;
const ct = res.headers.get("content-type") || "";
const raw = await res.text();
if (ct.includes("html")) {
const doc = new DOMParser().parseFromString(raw, "text/html");
doc.querySelectorAll("script,style,noscript").forEach((el) => el.remove());
return (doc.body?.innerText || "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000) || "（本文が空でした）";
}
return raw.slice(0, 6000);
} catch {
return "取得できませんでした。対処：そのサイトはブラウザからの直接取得（CORS）を許可していない可能性があります。";
} finally {
window.clearTimeout(t);
}
}
case "save_note": {
const title = String(args.title || "無題").slice(0, 80);
const content = String(args.content || "").slice(0, 20000);
if (!content) return "内容が空のため保存できませんでした。";
state.notes.unshift({ id: uid(), title, content, created: Date.now()});
persistNotes();
if (isLoggedIn()) void pushSync();
return `メモ「${title}」を保存しました。`;
}
case "search_notes": {
const q = String(args.query || "").toLowerCase();
const hits = state.notes
.filter((n) =>!q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
.slice(0, 5);
if (!hits.length) return "該当するメモはありませんでした。";
return hits.map((n) => `\n${n.content.slice(0, 600)}`).join("\n\n");
}
default:
return `未知のツールです: ${name}`;
}
} catch (e) {
return `ツール実行でエラーが発生しました: ${e instanceof Error? e.message: String(e)}`;
}
}

function throwIfAborted(): void {
if (runtime.abortCtl?.signal.aborted) {
throw new DOMException("aborted", "AbortError");
}
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, p: Provider): Promise<Record<string, unknown>> {
const ctl = new AbortController();
const timer = window.setTimeout(() => ctl.abort("timeout"), 90000);
try {
const res = await apiFetch(url, {
method: "POST",
headers: { "Content-Type": "application/json",...headers},
body: JSON.stringify(body),
signal: runtime.abortCtl?.signal?? ctl.signal,
});
if (!res.ok) throw new Error(friendlyError(res.status, await res.text(), p));
return (await res.json()) as Record<string, unknown>;
} finally {
window.clearTimeout(timer);
}
}

export interface AgentResult {
text: string;
steps: string[];
}

type OnStep = (steps: string[]) => void;

function systemText(): string {
return state.conf.system? `${state.conf.system}\n${AGENT_SYS}`: AGENT_SYS;
}

/* ---------- OpenAI互換（OpenAI / Mistral / Groq / OpenRouter / DeepSeek / Cloudflare / SambaNova） ---------- */

async function runAgentOpenAI(p: Provider, key: string, model: string, history: Message[], onStep: OnStep): Promise<AgentResult> {
const steps: string[] = [];
const tools = TOOL_DEFS.map((t) => ({
type: "function",
function: { name: t.name, description: t.description, parameters: t.parameters},
}));
const messages: Array<Record<string, unknown>> = [
{ role: "system", content: systemText()},
...history.map((m) => ({ role: m.role, content: m.content})),
];
for (let i = 0; i < MAX_STEPS; i++) {
throwIfAborted();
const j = await postJson(
`${effBase(p, key)}/chat/completions`,
{ Authorization: `Bearer ${effToken(p, key)}`},
{ model, messages, tools, tool_choice: "auto", temperature: state.conf.temp},
p,
);
const msg = (j.choices as Array<{ message?: Record<string, unknown>}>)?.[0]?.message;
if (!msg) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
const calls = (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string}}>) || [];
if (!calls.length) {
return { text: String(msg.content || ""), steps};
}
messages.push(msg);
for (const tc of calls) {
throwIfAborted();
let args: Record<string, unknown> = {};
try { args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;} catch { args = {};}
const result = await executeTool(tc.function.name, args);
steps.push(`${toolLabel(tc.function.name)}しました`);
onStep([...steps]);
messages.push({ role: "tool", tool_call_id: tc.id, content: result});
}
}
return { text: "（ツールの実行回数が上限に達しました。途中までの結果をもとに、質問を分けて再度お試しください）", steps};
}

/* ---------- Gemini ---------- */

interface GeminiPart {
text?: string;
functionCall?: { name: string; args: Record<string, unknown>};
functionResponse?: { name: string; response: { result: string}};
}

async function runAgentGemini(p: Provider, key: string, model: string, history: Message[], onStep: OnStep): Promise<AgentResult> {
const steps: string[] = [];
const contents: Array<{ role: string; parts: GeminiPart[]}> = history.map((m) => ({
role: m.role === "assistant"? "model": "user",
parts: [{ text: m.content}],
}));
const tools = [{
functionDeclarations: TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters})),
}];
for (let i = 0; i < MAX_STEPS; i++) {
throwIfAborted();
const j = await postJson(
`${p.base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
{},
{
contents,
tools,
systemInstruction: { parts: [{ text: systemText()}]},
generationConfig: { temperature: state.conf.temp},
},
p,
);
const parts = ((j.candidates as Array<{ content?: { parts?: GeminiPart[]}}>)?.[0]?.content?.parts) || [];
const calls = parts.filter((x) => x.functionCall);
if (!calls.length) {
const text = parts.map((x) => x.text || "").join("");
if (!text) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
return { text, steps};
}
contents.push({ role: "model", parts});
const responses: GeminiPart[] = [];
for (const c of calls) {
throwIfAborted();
const fc = c.functionCall as { name: string; args: Record<string, unknown>};
const result = await executeTool(fc.name, fc.args || {});
steps.push(`${toolLabel(fc.name)}しました`);
onStep([...steps]);
responses.push({ functionResponse: { name: fc.name, response: { result}}});
}
contents.push({ role: "user", parts: responses});
}
return { text: "（ツールの実行回数が上限に達しました。途中までの結果をもとに、質問を分けて再度お試しください）", steps};
}

/* ---------- Anthropic ---------- */

interface AnthBlock {
type: string;
text?: string;
id?: string;
name?: string;
input?: Record<string, unknown>;
}

async function runAgentAnthropic(p: Provider, key: string, model: string, history: Message[], onStep: OnStep): Promise<AgentResult> {
const steps: string[] = [];
const messages: Array<{ role: string; content: unknown}> = history.map((m) => ({ role: m.role, content: m.content}));
const tools = TOOL_DEFS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters}));
for (let i = 0; i < MAX_STEPS; i++) {
throwIfAborted();
const j = await postJson(
`${p.base}/messages`,
{
"x-api-key": key,
"anthropic-version": "2023-06-01",
"anthropic-dangerous-direct-browser-access": "true",
},
{ model, max_tokens: 4096, system: systemText(), messages, tools, temperature: state.conf.temp},
p,
);
const blocks = (j.content as AnthBlock[]) || [];
const uses = blocks.filter((b) => b.type === "tool_use");
if (!uses.length) {
const text = blocks.map((b) => b.text || "").join("");
if (!text) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
return { text, steps};
}
messages.push({ role: "assistant", content: blocks});
const results: Array<Record<string, unknown>> = [];
for (const u of uses) {
throwIfAborted();
const result = await executeTool(u.name || "", u.input || {});
steps.push(`${toolLabel(u.name || "")}しました`);
onStep([...steps]);
results.push({ type: "tool_result", tool_use_id: u.id, content: result});
}
messages.push({ role: "user", content: results});
}
return { text: "（ツールの実行回数が上限に達しました。途中までの結果をもとに、質問を分けて再度お試しください）", steps};
}

/* ---------- Cohere（JSON指示プロトコル） ---------- */

async function runAgentCohere(p: Provider, key: string, model: string, history: Message[], onStep: OnStep): Promise<AgentResult> {
const steps: string[] = [];
const toolGuide = TOOL_DEFS.map((t) => `- ${t.name}: ${t.description}`).join("\n");
const sys = `${systemText()}\nツールを使う場合は、次の形式のJSONコードブロックだけを出力してください（説明文は付けない）。\n\`\`\`json\n{"tool":"ツール名","args":{...}}\n\`\`\`\n使えるツール:\n${toolGuide}`;
const messages: Array<{ role: string; content: string}> = [
{ role: "system", content: sys},
...history.map((m) => ({ role: m.role, content: m.content})),
];
for (let i = 0; i < MAX_STEPS; i++) {
throwIfAborted();
const j = await postJson(
`${p.base}/v2/chat`,
{ Authorization: `Bearer ${key}`},
{ model, messages, temperature: state.conf.temp},
p,
);
const text = (((j.message as { content?: Array<{ text?: string}>})?.content) || []).map((c) => c.text || "").join("");
const m = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
let call: { tool: string; args?: Record<string, unknown>} | null = null;
if (m) {
try { call = JSON.parse(m[1]) as { tool: string; args?: Record<string, unknown>};} catch { call = null;}
}
if (!call ||!call.tool) {
if (!text) throw new Error("応答が空でした。対処：モデルを変えるか、もう一度送ってください。");
return { text, steps};
}
const result = await executeTool(call.tool, call.args || {});
steps.push(`${toolLabel(call.tool)}しました`);
onStep([...steps]);
messages.push({ role: "assistant", content: text});
messages.push({ role: "user", content: `ツール「${call.tool}」の実行結果:\n${result}\nこの結果を踏まえて続けてください。完了したら最終回答を書いてください。`});
}
return { text: "（ツールの実行回数が上限に達しました。途中までの結果をもとに、質問を分けて再度お試しください）", steps};
}

/** エージェント実行の入口（会社ごとの形式差を吸収） */
export function runAgent(
p: Provider, key: string, model: string, history: Message[], onStep: OnStep,
): Promise<AgentResult> {
switch (p.type) {
case "gemini":
return runAgentGemini(p, key, model, history, onStep);
case "anthropic":
return runAgentAnthropic(p, key, model, history, onStep);
case "cohere":
return runAgentCohere(p, key, model, history, onStep);
default:
return runAgentOpenAI(p, key, model, history, onStep);
}
}
