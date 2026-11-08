/* Eluntra Developer: AI開発エージェント
既存エージェントと同じ「JSONでツールを1つ選ぶ」方式で全プロバイダー共通に動かす。
モードによる書き込み禁止・確認・回数上限はプロンプトではなくコードで強制する。 */

import { completeChat} from "../lib/providers/chat";
import type { ChatMessage, ProviderDef} from "../lib/types";
import { devUid, listPaths, runFsTool, type FsChange} from "./fs";

export type DevMode = "plan" | "build" | "debug" | "review" | "ask" | "auto";

export const DEV_MODES: Array<{ id: DevMode; label: string; desc: string}> = [
{ id: "plan", label: "PLAN", desc: "分析と実装計画のみ（ファイルは変更しません）"},
{ id: "build", label: "BUILD", desc: "計画に沿って実装します"},
{ id: "debug", label: "DEBUG", desc: "エラーを調査して修正します"},
{ id: "review", label: "REVIEW", desc: "品質・セキュリティ・設計を確認します（変更しません）"},
{ id: "ask", label: "ASK", desc: "コードや技術の質問に答えます（変更しません）"},
{ id: "auto", label: "AUTO", desc: "分析→実装→実行確認→修正まで自動で進めます"},
];

export const READONLY_MODES: ReadonlySet<DevMode> = new Set(["plan", "review", "ask"]);

export interface ChangeRecord extends FsChange {
id: string;
at: number;
}

export type AgentEvent =
| { kind: "step"; label: string}
| { kind: "tool"; tool: string; detail: string; output: string}
| { kind: "change"; change: ChangeRecord}
| { kind: "note"; label: string};

export interface AgentContext {
getFiles: () => Record<string, string>;
/** AIによるファイル変更をアプリ状態へ反映する */
applyFiles: (files: Record<string, string>, change?: FsChange) => void;
/** 重要な変更の前にユーザーの許可を取る（UI側でインライン確認を出す） */
confirm: (description: string) => Promise<boolean>;
/** ターミナル実行（WebContainer）。使えない環境では理由を文字列で返す */
termExec: (command: string) => Promise<string>;
/** プレビューの状態説明 */
previewInfo: () => string;
/** このセッションで作成・確認済みのファイル（再確認を省略する） */
sessionFiles: Set<string>;
signal?: AbortSignal;
onEvent: (e: AgentEvent) => void;
}

const WRITE_TOOLS = new Set(["fs_write", "fs_edit", "fs_delete"]);
const MAX_STEPS = 25;
export const MAX_TOOL_STEPS = MAX_STEPS;

const TOOL_GUIDE = [
"あなたは Eluntra Developer のAIソフトウェアエンジニアです。ユーザーのプロジェクト内で、実際にファイルを読み書きし、ターミナルで確認しながら開発を進めてください。",
"各回の応答は、次のどちらか一方だけにしてください。",
"1) ツールを使う場合: ```json ブロックで {\"tool\":\"ツール名\",\"args\":{...}} を1つだけ返す",
"2) 最終回答の場合: 普通の文章で結果を報告する（JSONにしない）",
"使えるツール:",
"- fs_list {}: プロジェクトのファイル一覧",
"- fs_read {path}: ファイルを読む",
"- fs_write {path, content}: ファイルを新規作成または全体を上書きする（content はファイル全体）",
"- fs_edit {path, old, new, replaceAll?}: 正確に一致する部分文字列を置換する（old は一意に特定できる長さにする）",
"- fs_delete {path}: ファイルを削除する",
"- code_search {query}: プロジェクト全体を文字列検索する",
"- term_exec {command}: ターミナルでコマンドを実行する（Node.js環境のみ。npm install / npm run build / npm test / node など）",
"- preview_info {}: プレビューの状態を確認する",
"ルール:",
"- 存在を確かめていないファイルは、まず fs_list / fs_read で確認してから編集する",
"- 変更は小さく確実に。大きな新規ファイルは fs_write、小さな修正は fs_edit を使う",
"- term_exec が使えない環境では、実行確認ができない旨を最終報告に明記する（実行したことにしない）",
"- 秘密情報（APIキー等）をコードに直書きしない。環境変数や設定ファイルの参照にする",
"- 同じ失敗を繰り返さない。エラーが出たら内容を読んで別の手を考える",
].join("\n");

const MODE_GUIDE: Record<DevMode, string> = {
plan: "現在のモードは PLAN です。ファイルの変更はできません。プロジェクトを調査し、実装計画（目的、手順、変更ファイル、検証方法）を最終回答としてまとめてください。",
build: "現在のモードは BUILD です。計画や指示に沿って、実際にファイルを作成・編集してください。終わったら何を作ったか報告してください。",
debug: "現在のモードは DEBUG です。エラーの原因を調査し、修正してください。可能なら term_exec でビルドやテストを実行して再現・確認してください。",
review: "現在のモードは REVIEW です。ファイルの変更はできません。コード品質、セキュリティ、設計の問題点を、重要度と該当箇所つきで報告してください。",
ask: "現在のモードは ASK です。ファイルの変更はできません。質問に答えてください。必要ならファイルを読んで根拠を示してください。",
auto: "現在のモードは AUTO です。分析→計画→実装→term_execでの動作確認（ビルド/テスト/起動）→エラー修正までを自律的に進めてください。確認できない項目は最終報告で『未確認』と明記してください。",
};

interface ToolCall {
tool: string;
args: Record<string, string>;
}

function parseToolCall(text: string): ToolCall | null {
const m = text.match(/```json\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*"tool"[\s\S]*\})/);
if (!m) return null;
try {
const j = JSON.parse(m[1]) as { tool?: string; args?: Record<string, unknown>};
if (!j.tool) return null;
const args: Record<string, string> = {};
for (const [k, v] of Object.entries(j.args || {})) args[k] = typeof v === "string"? v: JSON.stringify(v);
return { tool: j.tool, args};
} catch {
return null;
}
}

function projectContext(files: Record<string, string>): string {
const paths = listPaths(files);
const tree = paths.map((p) => `- ${p}`).join("\n") || "（ファイルなし）";
const pkg = files["package.json"];
return [
"",
tree,
pkg? `\n${pkg.slice(0, 2000)}`: "",
]
.filter(Boolean)
.join("\n");
}

const TOOL_LABEL: Record<string, string> = {
fs_list: "ファイル一覧を確認",
fs_read: "ファイルを読んでいます",
fs_write: "ファイルを作成・更新",
fs_edit: "ファイルを編集",
fs_delete: "ファイルを削除",
code_search: "コードを検索",
term_exec: "ターミナルで実行",
preview_info: "プレビューを確認",
};

/** ツール1件を実行し、モデルへ返す結果文字列を返す（変更があれば ctx 経由で反映・記録される） */
async function execTool(call: ToolCall, mode: DevMode, ctx: AgentContext): Promise<string> {
const { tool, args} = call;

if (WRITE_TOOLS.has(tool) && READONLY_MODES.has(mode)) {
return `モード ${mode.toUpperCase()} ではファイルを変更できません。ツールの実行を拒否しました。調査と報告のみ行ってください。`;
}

if (tool === "term_exec") {
ctx.onEvent({ kind: "tool", tool, detail: args.command || "", output: ""});
const out = await ctx.termExec(args.command || "");
ctx.onEvent({ kind: "tool", tool, detail: args.command || "", output: out.slice(0, 2000)});
return out.slice(0, 8000);
}
if (tool === "preview_info") {
return ctx.previewInfo();
}

// fs系: 確認ポリシー
if (WRITE_TOOLS.has(tool)) {
const files = ctx.getFiles();
const path = args.path || "";
const isExisting = path in files;
const needsConfirm =
(tool === "fs_delete" && isExisting &&!ctx.sessionFiles.has(path)) ||
(tool === "fs_write" && isExisting &&!ctx.sessionFiles.has(path)) ||
(tool === "fs_edit" && isExisting &&!ctx.sessionFiles.has(path));
if (needsConfirm) {
const desc =
tool === "fs_delete"
? `AIがファイル「${path}」を削除しようとしています`
: `AIが既存ファイル「${path}」を変更しようとしています（このセッションで作成したファイルではありません）`;
const ok = await ctx.confirm(desc);
if (!ok) return `ユーザーが変更を承認しなかったため、${tool}（${path}）は実行しませんでした。別の方法を検討するか、最終報告で理由を伝えてください。`;
ctx.sessionFiles.add(path);
}
}

ctx.onEvent({ kind: "tool", tool, detail: args.path || args.query || "", output: ""});
try {
const result = runFsTool(ctx.getFiles(), tool, args);
if (result.change) {
ctx.applyFiles(result.files, result.change);
ctx.sessionFiles.add(result.change.path);
const rec: ChangeRecord = {...result.change, id: devUid(), at: Date.now()};
ctx.onEvent({ kind: "change", change: rec});
}
ctx.onEvent({ kind: "tool", tool, detail: args.path || args.query || "", output: result.output.slice(0, 2000)});
return result.output;
} catch (e) {
throw e instanceof Error? e: new Error(String(e));
}
}

export async function runDevAgent(opts: {
provider: ProviderDef;
model: string;
mode: DevMode;
history: ChatMessage[];
userText: string;
ctx: AgentContext;
}): Promise<{ text: string; stopped?: string}> {
const { provider, model, mode, ctx} = opts;
const files = ctx.getFiles();
const convo: ChatMessage[] = [
{ role: "user", content: [TOOL_GUIDE, MODE_GUIDE[mode], projectContext(files)].join("\n\n")},
{ role: "assistant", content: "了解しました。プロジェクトを確認しながら進めます。"},
...opts.history.slice(-10),
{ role: "user", content: opts.userText},
];

const errorCounts = new Map<string, number>();
const callCounts = new Map<string, number>();
let finalText = "";

for (let step = 0; step < MAX_STEPS; step++) {
if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
ctx.onEvent({ kind: "step", label: step === 0? "タスクを分析中": "次の作業を検討中"});
const r = await completeChat(provider, model, convo, ctx.signal);
const call = parseToolCall(r.text);
if (!call) {
finalText = r.text;
break;
}

// 同一呼び出しの繰り返し検出
const callKey = `${call.tool}:${JSON.stringify(call.args)}`;
const cc = (callCounts.get(callKey) || 0) + 1;
callCounts.set(callKey, cc);
if (cc >= 3) {
return {
text: finalText,
stopped: `同じツール呼び出し（${call.tool}）が繰り返されたため、ループを止めて停止しました。指示を具体的に変えて、もう一度お試しください。`,
};
}

ctx.onEvent({ kind: "step", label: TOOL_LABEL[call.tool] || "作業中"});
let result = "";
let isError = false;
try {
result = await execTool(call, mode, ctx);
} catch (e) {
isError = true;
result = `エラー: ${e instanceof Error? e.message: String(e)}`;
}

if (isError) {
const key = result.slice(0, 200);
const n = (errorCounts.get(key) || 0) + 1;
errorCounts.set(key, n);
if (n >= 3) {
return {
text: finalText,
stopped: `同じエラーが3回続いたため停止しました。最後のエラー: ${result}`,
};
}
}

convo.push({ role: "assistant", content: r.text});
convo.push({
role: "user",
content: `ツール ${call.tool} の結果:\n${result}\n\n続けてください。追加のツールが必要ならJSONで1つ、終わるなら最終報告を書いてください。`,
});

if (step === MAX_STEPS - 1) {
const last = await completeChat(
provider,
model,
[...convo, { role: "user", content: "手順の上限に達しました。ここまでの作業結果を最終報告としてまとめてください（JSONは使わないでください）。未完了の項目は正直に書いてください。"}],
ctx.signal,
);
finalText = last.text;
}
}
return { text: finalText};
}
