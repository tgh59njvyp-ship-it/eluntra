/* Eluntra Developer: AI開発エージェント
既存エージェントと同じ「JSONでツールを1つ選ぶ」方式で全プロバイダー共通に動かす。
モードによる書き込み禁止・確認・回数上限はプロンプトではなくコードで強制する。 */

import { completeChat} from "../lib/providers/chat";
import type { ChatMessage, ProviderDef} from "../lib/types";
import { devUid, listPaths, normalizePath, runFsTool, type FsChange} from "./fs";
import { isReadOnlySql } from "./db";

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
| { kind: "step"; label: string; step?: number; max?: number}
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
/** データベース一覧（テキスト） */
dbList?: () => Promise<string>;
/** データベースのスキーマ（テキスト） */
dbSchema?: (name: string) => Promise<string>;
/** SQL実行（結果テキスト） */
dbQuery?: (name: string, sql: string) => Promise<string>;
/** 実行環境などの追加コンテキスト */
contextNote?: () => string;
/** このセッションで作成・確認済みのファイル（再確認を省略する） */
sessionFiles: Set<string>;
signal?: AbortSignal;
onEvent: (e: AgentEvent) => void;
}

const WRITE_TOOLS = new Set(["fs_write", "fs_edit", "fs_delete"]);
const MAX_STEPS = 25;
export const MAX_TOOL_STEPS = MAX_STEPS;

/* 探索ループ対策: 読み取り専用ツールの連続使用に上限を設け、
   変化のない手順が続いたら正直に停止する（v7.2.1） */
const READONLY_TOOLS: ReadonlySet<string> = new Set(["fs_list", "fs_read", "code_search", "preview_info", "db_list", "db_schema"]);
/** 書き込み/ターミナル等の「前進」が無いまま許す読み取り回数（読み取り専用モードは調査が本業なので広め） */
export const EXPLORE_BUDGET = 5;
export const EXPLORE_BUDGET_READONLY_MODE = 10;
/** ファイル変更・ターミナル実行・最終回答のいずれも無い手順がこの回数続いたら停止する */
export const STALL_LIMIT = 6;

const TOOL_GUIDE = [
"あなたは Eluntra Developer のAIソフトウェアエンジニアです。ユーザーのプロジェクト内で、実際にファイルを読み書きし、ターミナルで確認しながら開発を進めてください。",
"各回の応答は、次のどちらか一方だけにしてください。",
"1) ツールを使う場合: ```json ブロックで {\"tool\":\"ツール名\",\"args\":{...}} を1つだけ返す",
"2) 最終回答の場合: 普通の文章で結果を報告する（JSONにしない）",
"使えるツール:",
"- fs_list {}: プロジェクトのファイル一覧（ファイルツリーはこの指示の末尾にすでに含まれています。特定のサブフォルダを再確認したいときだけ使ってください）",
"- fs_read {path}: ファイルを読む",
"- fs_write {path, content}: ファイルを新規作成または全体を上書きする（content はファイル全体）",
"- fs_edit {path, old, new, replaceAll?}: 正確に一致する部分文字列を置換する（old は一意に特定できる長さにする）",
"- fs_delete {path}: ファイルを削除する",
"- code_search {query}: プロジェクト全体を文字列検索する",
"- term_exec {command}: ターミナルでコマンドを実行する。Node.js系（npm install / npm run build / npm test / node など）は WebContainer、Python系（python file.py / python -c \"...\" / pip install <純Pythonパッケージ>）は Pyodide（CPython のWASM版）で実行される",
"- db_list {}: このプロジェクトのデータベース一覧（SQLite / PostgreSQL。どちらもブラウザ内で実際に動作する）",
"- db_schema {db}: データベースのテーブルと列を確認する",
"- db_query {db, sql}: SQLを実行する（結果は最大100行）。書き込みSQLは読み取り専用モードでは実行できない",
"- preview_info {}: プレビューの状態を確認する",
"ルール:",
"- プロジェクトのファイルツリーと package.json は、この指示の末尾にすでに含まれています。存在確認のために fs_list を繰り返す必要はありません",
"- 編集対象ファイルの現在の内容が必要な場合だけ fs_read で確認してから編集する",
"- BUILD / AUTO / DEBUG では、調査は必要最小限にし、最初の数手順以内にファイルの作成・編集またはターミナル実行を始めること。確認だけを繰り返さない",
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
"プロジェクトのファイル一覧（このツリーは提示済みです。確認のために fs_list を呼ぶ必要はありません）:",
tree,
pkg? `\npackage.json:\n${pkg.slice(0, 2000)}`: "",
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
db_list: "データベース一覧を確認",
db_schema: "スキーマを確認",
db_query: "SQLを実行",
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

if (tool === "db_list" || tool === "db_schema" || tool === "db_query") {
ctx.onEvent({ kind: "tool", tool, detail: args.db || "", output: ""});
let out = "";
if (tool === "db_list") {
out = ctx.dbList? await ctx.dbList(): "データベース機能が接続されていません";
} else if (tool === "db_schema") {
out = ctx.dbSchema? await ctx.dbSchema(args.db || ""): "データベース機能が接続されていません";
} else {
const sql = args.sql || "";
if (READONLY_MODES.has(mode) &&!isReadOnlySql(sql)) {
out = `モード ${mode.toUpperCase()} ではデータベースへの書き込みSQLは実行できません。SELECTなどの読み取りのみ可能です。`;
} else {
out = ctx.dbQuery? await ctx.dbQuery(args.db || "", sql): "データベース機能が接続されていません";
}
}
ctx.onEvent({ kind: "tool", tool, detail: args.db || "", output: out.slice(0, 2000)});
return out.slice(0, 8000);
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
{ role: "user", content: [TOOL_GUIDE, MODE_GUIDE[mode], projectContext(files), ctx.contextNote? ctx.contextNote(): ""].filter(Boolean).join("\n\n")},
{ role: "assistant", content: "了解しました。プロジェクトを確認しながら進めます。"},
...opts.history.slice(-10),
{ role: "user", content: opts.userText},
];

const errorCounts = new Map<string, number>();
const callCounts = new Map<string, number>();
const toolUseCounts = new Map<string, number>();
const readCache = new Map<string, string>();
const exploreBudget = READONLY_MODES.has(mode)? EXPLORE_BUDGET_READONLY_MODE: EXPLORE_BUDGET;
let exploreStreak = 0;
let stallSteps = 0;
let budgetWarned = false;
let finalText = "";

// ファイル変更を数えるラッパー（execTool の進捗判定用）
let changeCount = 0;
const trackingCtx: AgentContext = {
...ctx,
onEvent: (e) => {
if (e.kind === "change") changeCount++;
ctx.onEvent(e);
},
};

const stallMessage = (atStep: number): string => {
const top = [...toolUseCounts.entries()]
.sort((a, b) => b[1] - a[1])
.slice(0, 3)
.map(([t, n]) => `${t} を${n}回`)
.join("、");
const bullets = ["・そのまま「もう一度送る」"];
if (mode !== "build" && mode !== "auto") {
bullets.push("・BUILD または AUTO モードに切り替えて送り直す（現在のモードではファイルを変更しません）");
}
bullets.push("・指示を具体的にする（例:「src/App.tsx に〇〇の機能を追加して」）");
return [
"作業が前に進まなくなったため、ループを避けて停止しました。",
`この実行では ${top || "同じ確認"} 繰り返しましたが、ファイルの作成・変更やターミナル実行には進みませんでした（変化のない手順が${STALL_LIMIT}回続き、全体の${atStep}手順目で停止）。`,
"次のいずれかで再試行してください。",
...bullets,
].join("\n");
};

for (let step = 0; step < MAX_STEPS; step++) {
if (ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
ctx.onEvent({ kind: "step", label: step === 0? "タスクを分析中": "次の作業を検討中", step: step + 1, max: MAX_STEPS});
const r = await completeChat(provider, model, convo, ctx.signal);
const call = parseToolCall(r.text);
if (!call) {
finalText = r.text;
break;
}
toolUseCounts.set(call.tool, (toolUseCounts.get(call.tool) || 0) + 1);

// 同一呼び出しの繰り返し検出（完全一致。引数を変えた繰り返しは後段の重複判定・探索上限・停滞検出で止める）
const callKey = `${call.tool}:${JSON.stringify(call.args)}`;
const cc = (callCounts.get(callKey) || 0) + 1;
callCounts.set(callKey, cc);
if (cc >= 3) {
return {
text: finalText,
stopped: `同じツール呼び出し（${call.tool}）が繰り返されたため、ループを止めて停止しました。指示を具体的に変えて、もう一度お試しください。`,
};
}

const detail = (call.args.path || call.args.query || call.args.command || call.args.db || "").slice(0, 80);
ctx.onEvent({ kind: "step", label: `${TOOL_LABEL[call.tool] || "作業中"}${detail? ` — ${detail}`: ""}`, step: step + 1, max: MAX_STEPS});

const changesAtStart = changeCount;
let result = "";
let isError = false;
let progressed = false;
let acted = false;
let freeWarning = false;
let executedRead = false;

const readKey = normalizedReadKey(call);
if (readKey !== null && readCache.has(readKey)) {
// 重複した読み取り: 全文を返さず、取得済みの要約だけを返す
result = `（この結果は取得済みです）${call.tool} の結果はこの実行で既に取得しています。要約: ${readCache.get(readKey)}\n同じ確認を繰り返しても新しい情報は得られません。次はファイルの作成・編集に進むか、最終回答を書いてください。`;
ctx.onEvent({ kind: "tool", tool: call.tool, detail, output: result.slice(0, 2000)});
} else if (readKey !== null && exploreStreak >= exploreBudget) {
// 探索の上限: ツール層で実行を拒否する
result = READONLY_MODES.has(mode)
? `これ以上の探索はできません（読み取りだけのツール呼び出しが上限の${exploreBudget}回に達しました）。プロジェクトのファイルツリーと package.json は、最初の指示（システムプロンプト）にすでに含まれています。集めた情報で最終回答（計画・調査結果・レビュー）をまとめてください。`
: `これ以上プロジェクトを探索できません（読み取りだけのツール呼び出しが上限の${exploreBudget}回に達しました）。プロジェクトのファイルツリーと package.json は、最初の指示（システムプロンプト）にすでに含まれています。新しい情報は得られないので、次は fs_write / fs_edit でファイルの作成・編集に進むか、最終回答を書いてください。`;
ctx.onEvent({ kind: "tool", tool: call.tool, detail, output: result.slice(0, 2000)});
// 上限の拒否は、まず1回だけ「警告」としてモデルに届ける（停滞カウンタを進めない）。
// 警告のあとも探索を続ける場合は通常どおり数え、停滞検出で止める
if (!budgetWarned) {
budgetWarned = true;
freeWarning = true;
}
} else {
try {
result = await execTool(call, mode, trackingCtx);
} catch (e) {
isError = true;
result = `エラー: ${e instanceof Error? e.message: String(e)}`;
}
if (!isError && readKey !== null) {
readCache.set(readKey, summarizeResult(result));
exploreStreak++;
executedRead = true;
}
}

if (changeCount > changesAtStart) {
// ファイルが変わった = 前進。読み取りキャッシュは古くなるので破棄する
acted = true;
progressed = true;
readCache.clear();
} else if (call.tool === "term_exec" || (call.tool === "db_query" &&!READONLY_MODES.has(mode))) {
// ターミナル実行・DB操作は実行そのものが前進
acted =!isError || call.tool === "term_exec";
progressed = acted;
} else if (executedRead && READONLY_MODES.has(mode)) {
// 読み取り専用モードでは「新しい情報を読む」こと自体が仕事の前進（停滞とは数えない）。
// ただし探索ストリークは進めたままにし、上限（予算）で必ず止める
progressed = true;
}
if (acted) exploreStreak = 0;
if (progressed) {
stallSteps = 0;
} else if (!freeWarning) {
stallSteps++;
if (stallSteps >= STALL_LIMIT) {
return { text: finalText, stopped: stallMessage(step + 1)};
}
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

/** 読み取りツールの「同じ結果になる呼び出し」を判定するキー。対象外ツールは null。
    fs_list は実装側が引数を無視して常に全一覧を返すため、引数が違っても同一結果として扱う */
function normalizedReadKey(call: ToolCall): string | null {
if (!READONLY_TOOLS.has(call.tool)) return null;
switch (call.tool) {
case "fs_list":
return "fs_list";
case "fs_read":
return `fs_read:${normalizePath(call.args.path || "")}`;
case "code_search":
return `code_search:${(call.args.query || "").trim().replace(/\s+/g, " ")}`;
case "db_schema":
return `db_schema:${(call.args.db || "").trim()}`;
default:
return call.tool;
}
}

/** キャッシュ用にツール結果を短い要約へ圧縮する */
function summarizeResult(output: string): string {
const oneLine = output.replace(/\s+/g, " ").trim();
return oneLine.length > 160? oneLine.slice(0, 160) + "…": oneLine;
}
