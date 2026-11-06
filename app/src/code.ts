import { runSandboxedJs} from "./agent";
import { callChat} from "./api";
import { isLoggedIn, pushSync} from "./auth";
import { md} from "./markdown";
import { closeSheet, openSheet} from "./render";
import { curModel, curProv, load, save, state} from "./state";
import { $, toast} from "./util";

/**
* コードモード（多言語対応・コード特化）。
* 言語ごとに編集・保存し、HTML/CSS/Markdownはプレビュー、JavaScriptはサンドボックス実行、
* PythonはPyodide（ブラウザ内Python）で実行、JSONは整形・検証ができる。
* AIは言語専門の指示でコードを生成・修正する。コードは端末保存＋Supabase同期。
*/

export const CODES_LS_KEY = "eluntra_codes";
const LANG_LS_KEY = "eluntra_code_lang";
const OLD_CODE_LS_KEY = "eluntra_code";

type RunKind = "preview" | "js" | "python" | "css" | "json" | "md" | "none";

interface Lang {
id: string;
name: string;
fence: string;
ext: string;
run: RunKind;
runLabel: string;
starter: string;
}

const STARTER_HTML = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>マイ・ページ</title>
<style>
body { font-family: sans-serif; background: #FBFAF7; color: #1B1B18; padding: 32px 20px;}
h1 { font-size: 28px;}
button { background: #1E4D3B; color: #fff; border: 0; border-radius: 10px; padding: 12px 20px; font-size: 16px;}
</style>
</head>
<body>
<h1>こんにちは</h1>
<p>これは最初のページです。下の欄からAIに作り直してもらえます。</p>
<p>押した回数: <b id="n">0</b></p>
<button id="b">押してみる</button>
<script>
let n = 0;
document.getElementById("b").onclick = () => {
n++;
document.getElementById("n").textContent = n;
};
<\/script>
</body>
</html>`;

export const LANGS: Lang[] = [
{ id: "html", name: "HTML", fence: "html", ext: "html", run: "preview", runLabel: "プレビュー", starter: STARTER_HTML},
{
id: "javascript", name: "JavaScript", fence: "javascript", ext: "js", run: "js", runLabel: "実行する",
starter: `// JavaScriptのサンプル\nconst scores = [72, 85, 90, 68, 95];\nconst total = scores.reduce((a, b) => a + b, 0);\nconsole.log("合計:", total);\nconsole.log("平均:", total / scores.length);\nconsole.log("最高:", Math.max(...scores));`,
},
{
id: "typescript", name: "TypeScript", fence: "typescript", ext: "ts", run: "none", runLabel: "",
starter: `// TypeScriptのサンプル（編集とAI生成に対応。実行はJavaScript欄で）\ninterface User {\n name: string;\n score: number;\n}\n\nfunction rank(users: User[]): string[] {\n return users\n.slice()\n.sort((a, b) => b.score - a.score)\n.map((u, i) => (i + 1) + "位: " + u.name + " (" + u.score + ")");\n}`,
},
{
id: "python", name: "Python", fence: "python", ext: "py", run: "python", runLabel: "実行する",
starter: `# Pythonのサンプル（ブラウザ内蔵のPythonで実行されます）\nscores = [72, 85, 90, 68, 95]\nprint("合計:", sum(scores))\nprint("平均:", sum(scores) / len(scores))\nprint("最高:", max(scores))`,
},
{
id: "css", name: "CSS", fence: "css", ext: "css", run: "css", runLabel: "プレビュー",
starter: `/* CSSのサンプル（右のプレビュー用ページに適用されます） */\n.card {\n border: 2px solid #1E4D3B;\n background: #EAF3EE;\n}\nbutton {\n background: #1E4D3B;\n border-radius: 999px;\n}`,
},
{
id: "json", name: "JSON", fence: "json", ext: "json", run: "json", runLabel: "整形・検証",
starter: `{\n "app": "Eluntra",\n "version": 4,\n "features": ["chat", "agent", "code"],\n "dark": false\n}`,
},
{
id: "markdown", name: "Markdown", fence: "markdown", ext: "md", run: "md", runLabel: "プレビュー",
starter: `# メモ\n\n## 今日やること\n\n- **買い物**：牛乳と卵\n- 散歩 30分\n- 本を10ページ読む\n\n> 無理のない範囲で。`,
},
];

export function langById(id: string): Lang {
return LANGS.find((l) => l.id === id)?? LANGS[0];
}

let curLang: string = load<string>(LANG_LS_KEY, "html");
if (!LANGS.some((l) => l.id === curLang)) curLang = "html";

export function getCodes(): Record<string, string> {
const codes = load<Record<string, string>>(CODES_LS_KEY, {});
if (!codes.html) {
const old = load<string>(OLD_CODE_LS_KEY, "");
if (old) codes.html = old;
}
return codes;
}

export function setCodes(codes: Record<string, string>): void {
save(CODES_LS_KEY, codes);
}

function currentCode(): string {
const codes = getCodes();
return codes[curLang]?? langById(curLang).starter;
}

function persistEditor(sync = true): void {
const codes = getCodes();
codes[curLang] = editor().value;
setCodes(codes);
if (sync && isLoggedIn()) void pushSync();
}

/** 互換用：HTMLのコード（公開タブのコピーなど） */
export function getCode(): string {
return getCodes().html?? STARTER_HTML;
}

function editor(): HTMLTextAreaElement {
return $("#codeEditor") as HTMLTextAreaElement;
}

/** AIの応答からコードを取り出す */
export function extractCode(text: string): string | null {
const fenced = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
if (fenced && fenced[1].trim()) return fenced[1].trim();
const docStart = text.search(/<!DOCTYPE html|<html[\s>]/i);
if (docStart >= 0) return text.slice(docStart).trim();
return null;
}

/* ---------- 表示・タブ ---------- */

type CodeTab = "edit" | "out" | "pub";

function setCodeTab(tab: CodeTab): void {
$("#tabCodeEdit").classList.toggle("on", tab === "edit");
$("#tabCodePrev").classList.toggle("on", tab === "out");
$("#tabCodePub").classList.toggle("on", tab === "pub");
const body = $(".code-body");
body.classList.toggle("show-out", tab === "out");
body.classList.toggle("show-pub", tab === "pub");
if (tab === "out") void runOrPreview(false);
}

function updateGutter(): void {
const lines = editor().value.split("\n").length;
const g = $("#codeGutter");
let html = "";
for (let i = 1; i <= lines; i++) html += i + "\n";
g.textContent = html;
g.scrollTop = editor().scrollTop;
}

function applyLangUI(): void {
const lang = langById(curLang);
($("#codeLang") as HTMLSelectElement).value = curLang;
const runBtn = $("#btnCodeRun") as HTMLButtonElement;
if (lang.run === "none") {
runBtn.style.display = "none";
} else {
runBtn.style.display = "";
runBtn.textContent = lang.runLabel;
}
$("#tabCodePrevLabel").textContent = lang.run === "js" || lang.run === "python"? "実行結果": "プレビュー";
updateGutter();
}

function switchLang(id: string): void {
if (id === curLang) return;
persistEditor(false);
curLang = id;
save(LANG_LS_KEY, curLang);
editor().value = currentCode();
applyLangUI();
setStatus(id === "typescript"? "TypeScriptは編集とAI生成に対応しています（実行はJavaScript欄でできます）。": "");
if (isLoggedIn()) void pushSync();
}

export function openCode(): void {
editor().value = currentCode();
applyLangUI();
setCodeTab("edit");
openSheet("codeSheet");
}

/* ---------- 実行・プレビュー ---------- */

function setStatus(msg: string): void {
$("#codeStatus").textContent = msg;
}

function showOutput(text: string): void {
const pre = $("#codeOutput");
pre.style.display = "block";
($("#codePreview") as HTMLIFrameElement).style.display = "none";
$("#codeMd").style.display = "none";
pre.textContent = text;
}

function showFrame(html: string): void {
const frame = $("#codePreview") as HTMLIFrameElement;
frame.style.display = "block";
$("#codeOutput").style.display = "none";
$("#codeMd").style.display = "none";
frame.srcdoc = html;
}

function showMd(html: string): void {
const box = $("#codeMd");
box.style.display = "block";
($("#codePreview") as HTMLIFrameElement).style.display = "none";
$("#codeOutput").style.display = "none";
box.innerHTML = html;
}

const CSS_DEMO = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><style>
body{font-family:sans-serif;padding:24px;color:#1B1B18;background:#fff}
.card{border:1px solid #D8D6CC;border-radius:14px;padding:18px;margin:14px 0}
button{background:#5C5C55;color:#fff;border:0;border-radius:10px;padding:10px 18px}
</style><style id="userCss"></style></head><body>
<h1>見出しの例</h1><p>本文の例です。リンクは <a href="#">こちら</a>。</p>
<div class="card"><h2>カードの例</h2><p>このカードとボタンに、左のCSSが適用されます。</p><button>ボタンの例</button></div>
<ul><li>リスト1</li><li>リスト2</li></ul></body></html>`;

interface PyodideLike {
setStdout: (o: { batched: (s: string) => void}) => void;
setStderr: (o: { batched: (s: string) => void}) => void;
runPythonAsync: (code: string) => Promise<unknown>;
}
let pyodidePromise: Promise<PyodideLike> | null = null;

function loadPyodideOnce(): Promise<PyodideLike> {
if (pyodidePromise) return pyodidePromise;
pyodidePromise = new Promise<PyodideLike>((resolve, reject) => {
const w = window as unknown as { loadPyodide?: (o: { indexURL: string}) => Promise<PyodideLike>};
const start = (): void => {
if (!w.loadPyodide) {
reject(new Error("Pythonの読み込みに失敗しました"));
return;
}
w.loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"}).then(resolve, reject);
};
if (w.loadPyodide) {
start();
return;
}
const script = document.createElement("script");
script.src = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js";
script.onload = start;
script.onerror = () => reject(new Error("Pythonの読み込みに失敗しました。通信状態を確認してください。"));
document.head.appendChild(script);
});
return pyodidePromise;
}

async function runOrPreview(switchTab = true): Promise<void> {
const lang = langById(curLang);
const code = editor().value;
if (switchTab) setCodeTab("out");
switch (lang.run) {
case "preview":
showFrame(code);
setStatus("プレビューを更新しました。");
return;
case "css": {
const doc = new DOMParser().parseFromString(CSS_DEMO, "text/html");
const styleEl = doc.querySelector("#userCss");
if (styleEl) styleEl.textContent = code;
showFrame("<!DOCTYPE html>\n" + doc.documentElement.outerHTML);
setStatus("サンプルページにCSSを適用しました。");
return;
}
case "md":
showMd(md(code));
setStatus("プレビューを更新しました。");
return;
case "json":
try {
const parsed: unknown = JSON.parse(code);
showOutput(JSON.stringify(parsed, null, 2));
setStatus("正しいJSONです。整形して表示しています。");
} catch (e) {
showOutput("");
setStatus(`JSONの形式が正しくありません：${e instanceof Error? e.message: String(e)}`);
}
return;
case "js": {
setStatus("実行中…");
const out = await runSandboxedJs(code);
showOutput(out);
setStatus("実行しました。");
return;
}
case "python": {
setStatus("Pythonを準備中…（初回は読み込みに時間がかかります）");
try {
const py = await loadPyodideOnce();
const lines: string[] = [];
py.setStdout({ batched: (t: string) => lines.push(t)});
py.setStderr({ batched: (t: string) => lines.push(t)});
setStatus("実行中…");
await py.runPythonAsync(code);
showOutput(lines.join("\n") || "（出力なし）");
setStatus("実行しました。");
} catch (e) {
showOutput("");
const msg = e instanceof Error? e.message: String(e);
setStatus(`実行できませんでした：${msg.split("\n").slice(-3).join(" ")}`);
}
return;
}
default:
return;
}
}

/* ---------- AI生成（コード特化） ---------- */

let aiBusy = false;

const PRESETS: Record<string, string> = {
fix: "このコードのバグを探して直してください。直した箇所と原因を、コードの後に短く教えてください。",
improve: "このコードを、動作を変えずに読みやすく・効率よく書き直してください。",
comment: "このコードに、処理の流れが分かる日本語のコメントを付けてください（動作は変えないでください）。",
example: "このコードの使い方と、実行例（サンプルデータと期待する出力）を教えてください。",
};

async function aiGenerate(): Promise<void> {
if (aiBusy) return;
const input = $("#codePrompt") as HTMLInputElement;
const inst = input.value.trim();
if (!inst) {
setStatus("AIへの依頼を入力してください（例：ダークな時計のページにして）。");
return;
}
const p = curProv();
const key = (state.keys[p.id] || "").trim();
if (!key) {
setStatus(`${p.name}のキーが未設定です。対処：設定でキーを貼ってから、もう一度押してください。`);
return;
}
const lang = langById(curLang);
aiBusy = true;
const btn = $("#btnCodeAI") as HTMLButtonElement;
btn.disabled = true;
setStatus("AIが作成中です…");
const prompt =
`あなたは${lang.name}のシニアエンジニアです。次の依頼に沿って、${lang.name}のコードを作成（または修正）してください。` +
`完成したコード全体を必ず \`\`\`${lang.fence} のコードブロックで返し、説明は最小限にしてください。\n\n` +
`\n${inst}\n\n\n\`\`\`${lang.fence}\n${editor().value}\n\`\`\``;
try {
const full = await callChat(p, key, curModel(), [{ role: "user", content: prompt}], (partial) => {
setStatus(`AIが作成中です…（${partial.length}文字）`);
});
const code = extractCode(full);
if (!code) {
setStatus("AIの回答にコードが含まれていなかったため、反映しませんでした。依頼を具体的にして、もう一度お試しください。");
return;
}
editor().value = code;
persistEditor();
updateGutter();
setStatus("反映しました。");
input.value = "";
toast("コードを反映しました");
if (lang.run!== "none") setCodeTab("out");
} catch (e) {
setStatus(e instanceof Error? e.message: String(e));
} finally {
aiBusy = false;
btn.disabled = false;
}
}

async function copyCode(): Promise<void> {
try {
await navigator.clipboard.writeText(editor().value);
toast("コードをコピーしました");
} catch {
editor().select();
toast("コピーできませんでした。編集欄で長押ししてコピーしてください");
}
}

function downloadCode(): void {
const lang = langById(curLang);
const blob = new Blob([editor().value], { type: "text/plain"});
const a = document.createElement("a");
a.href = URL.createObjectURL(blob);
a.download = `eluntra-code.${lang.ext}`;
a.click();
window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** コードモードのイベント配線（main.tsの初期化から呼ぶ） */
export function initCode(): void {
const ed = editor();
ed.addEventListener("input", () => {
persistEditor(false);
updateGutter();
});
ed.addEventListener("scroll", () => {
$("#codeGutter").scrollTop = ed.scrollTop;
});
ed.addEventListener("blur", () => {
if (isLoggedIn()) void pushSync();
});
ed.addEventListener("keydown", (e: KeyboardEvent) => {
if (e.key === "Tab") {
e.preventDefault();
const start = ed.selectionStart;
const end = ed.selectionEnd;
ed.setRangeText(" ", start, end, "end");
persistEditor(false);
updateGutter();
}
});
($("#codeLang") as HTMLSelectElement).addEventListener("change", (e: Event) => {
switchLang((e.target as HTMLSelectElement).value);
});
$("#btnCodeRun").addEventListener("click", () => void runOrPreview(true));
$("#tabCodeEdit").addEventListener("click", () => setCodeTab("edit"));
$("#tabCodePrev").addEventListener("click", () => setCodeTab("out"));
$("#tabCodePub").addEventListener("click", () => setCodeTab("pub"));
$("#btnCopyCode").addEventListener("click", () => void copyCode());
document.querySelectorAll<HTMLElement>("[data-preset]").forEach((chip) => {
chip.addEventListener("click", () => {
const key = chip.getAttribute("data-preset") || "";
const input = $("#codePrompt") as HTMLInputElement;
input.value = PRESETS[key] || "";
input.focus();
});
});
$("#btnCodeAI").addEventListener("click", () => void aiGenerate());
$("#codePrompt").addEventListener("keydown", (e: KeyboardEvent) => {
if (e.key === "Enter") void aiGenerate();
});
$("#btnCodeDownload").addEventListener("click", downloadCode);
$("#btnCodeClose").addEventListener("click", () => closeSheet("codeSheet"));
}
