import { callChat} from "./api";
import { isLoggedIn, pushSync} from "./auth";
import { closeSheet, openSheet} from "./render";
import { CODE_LS_KEY, curModel, curProv, load, save, state} from "./state";
import { $, toast} from "./util";

/**
* コードモード：単一HTMLを編集し、その場でプレビューし、AIに作らせる・直させる。
* コードは端末に保存し、ログイン時はSupabase同期にも含める。
*/

const DEFAULT_CODE = `<!DOCTYPE html>
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

export function getCode(): string {
return load<string>(CODE_LS_KEY, DEFAULT_CODE);
}

export function setCode(v: string, sync = true): void {
save(CODE_LS_KEY, v);
if (sync && isLoggedIn()) void pushSync();
}

/** AIの応答からコードを取り出す（```html フェンス優先、無ければHTML文書そのもの） */
export function extractCode(text: string): string | null {
const fenced = text.match(/```(?:html|HTML)?\s*\n([\s\S]*?)```/);
if (fenced && fenced[1].trim()) return fenced[1].trim();
const docStart = text.search(/<!DOCTYPE html|<html[\s>]/i);
if (docStart >= 0) return text.slice(docStart).trim();
return null;
}

function editor(): HTMLTextAreaElement {
return $("#codeEditor") as HTMLTextAreaElement;
}

export function refreshCodePreview(): void {
const frame = $("#codePreview") as HTMLIFrameElement;
frame.srcdoc = editor().value;
}

function setCodeTab(preview: boolean): void {
$("#tabCodeEdit").classList.toggle("on",!preview);
$("#tabCodePrev").classList.toggle("on", preview);
$(".code-body").classList.toggle("show-prev", preview);
if (preview) refreshCodePreview();
}

export function openCode(): void {
editor().value = getCode();
setCodeTab(false);
openSheet("codeSheet");
}

let aiBusy = false;

async function aiGenerate(): Promise<void> {
if (aiBusy) return;
const input = $("#codePrompt") as HTMLInputElement;
const status = $("#codeStatus");
const inst = input.value.trim();
if (!inst) {
status.textContent = "AIへの依頼を入力してください（例：ダークな時計のページにして）。";
return;
}
const p = curProv();
const key = (state.keys[p.id] || "").trim();
if (!key) {
status.textContent = `${p.name}のキーが未設定です。対処：設定でキーを貼ってから、もう一度押してください。`;
return;
}
aiBusy = true;
const btn = $("#btnCodeAI") as HTMLButtonElement;
btn.disabled = true;
status.textContent = "AIが作成中です…";
const prompt =
"あなたは腕の良いフロントエンド開発者です。次の依頼に沿って、単一HTMLファイルとして完結するコードを作成（または修正）してください。" +
"説明は最小限にし、完成したコード全体を必ず ```html のコードブロックで返してください。\n\n" +
`\n${inst}\n\n\n\`\`\`html\n${editor().value}\n\`\`\``;
try {
const full = await callChat(p, key, curModel(), [{ role: "user", content: prompt}], (partial) => {
status.textContent = `AIが作成中です…（${partial.length}文字）`;
});
const code = extractCode(full);
if (!code) {
status.textContent = "AIの回答にコードが含まれていなかったため、反映しませんでした。依頼を具体的にして、もう一度お試しください。";
return;
}
editor().value = code;
setCode(editor().value);
setCodeTab(true);
status.textContent = "反映しました。プレビューで確認できます。";
input.value = "";
toast("コードを反映しました");
} catch (e) {
status.textContent = e instanceof Error? e.message: String(e);
} finally {
aiBusy = false;
btn.disabled = false;
}
}

function downloadCode(): void {
const blob = new Blob([editor().value], { type: "text/html"});
const a = document.createElement("a");
a.href = URL.createObjectURL(blob);
a.download = "eluntra-code.html";
a.click();
window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** コードモードのイベント配線（main.tsの初期化から呼ぶ） */
export function initCode(): void {
editor().addEventListener("input", () => setCode(editor().value, false));
editor().addEventListener("blur", () => {
if (isLoggedIn()) void pushSync();
});
$("#tabCodeEdit").addEventListener("click", () => setCodeTab(false));
$("#tabCodePrev").addEventListener("click", () => setCodeTab(true));
$("#btnCodeAI").addEventListener("click", () => void aiGenerate());
$("#codePrompt").addEventListener("keydown", (e: KeyboardEvent) => {
if (e.key === "Enter") void aiGenerate();
});
$("#btnCodeDownload").addEventListener("click", downloadCode);
$("#btnCodeClose").addEventListener("click", () => closeSheet("codeSheet"));
}
