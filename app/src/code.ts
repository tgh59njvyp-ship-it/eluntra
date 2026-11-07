import { runSandboxedJs } from "./agent";
import { callChat } from "./api";
import { PROVIDERS } from "./providers";
import { closeSheet, normLang, openSheet, renderChat } from "./render";
import { curModel, curSession, persistSessions, state } from "./state";
import { $, toast } from "./util";

/**
 * コード特化チャットの成果物まわり。
 * AI回答のコードブロック直下のバー（プレビュー／実行／コード／Zip／コピー／公開）を受け持ち、
 * 端末幅プレビュー・コード表示・Zip保存・公開（Simple URL Server埋め込み）のシートを制御する。
 */

interface Artifact {
  code: string;
  lang: string;
}

let current: Artifact = { code: "", lang: "" };

export const FILE_NAMES: Record<string, string> = {
  html: "index.html",
  javascript: "script.js",
  typescript: "main.ts",
  python: "main.py",
  css: "style.css",
  json: "data.json",
  markdown: "README.md",
};

export function fileNameFor(lang: string): string {
  return FILE_NAMES[lang] || "code.txt";
}

/* ---------- Zip作成（無圧縮STORE形式） ---------- */

const CRC_TABLE = ((): number[] => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function makeZipBlob(files: { name: string; content: string }[]): Blob {
  const enc = new TextEncoder();
  const chunks: BlobPart[] = [];
  const central: BlobPart[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer) as BlobPart, nameBytes as BlobPart, data as BlobPart);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer) as BlobPart, nameBytes as BlobPart);
    offset += 30 + nameBytes.length + data.length;
  }
  let centralSize = 0;
  central.forEach((c) => (centralSize += (c as Uint8Array).length));
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const parts: BlobPart[] = [...chunks, ...central, new Uint8Array(end.buffer) as BlobPart];
  return new Blob(parts, { type: "application/zip" });
}

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function downloadZip(a: Artifact): void {
  const blob = makeZipBlob([{ name: fileNameFor(a.lang), content: a.code }]);
  download(blob, "eluntra-code.zip");
  toast("Zipを保存しました（" + fileNameFor(a.lang) + "）");
}

/* ---------- プレビュー（端末幅切替） ---------- */

const DEVICES = [
  { name: "スマホ", w: 390, h: 844 },
  { name: "スマホ大", w: 430, h: 932 },
  { name: "タブレット", w: 768, h: 1024 },
  { name: "PC", w: 1280, h: 800 },
  { name: "全幅", w: 0, h: 0 },
];
let deviceIdx = 0;

function applyDevice(): void {
  const dev = DEVICES[deviceIdx];
  document.querySelectorAll<HTMLElement>("[data-dev]").forEach((chip) => {
    chip.classList.toggle("on", Number(chip.getAttribute("data-dev")) === deviceIdx);
  });
  const stage = $("#pvStage");
  const holder = $("#pvHolder");
  const frame = $("#pvFrame") as HTMLIFrameElement;
  $("#pvSize").textContent = dev.w === 0 ? "画面幅いっぱい" : `${dev.w} × ${dev.h}px`;
  if (dev.w === 0) {
    holder.style.width = "100%";
    holder.style.height = "100%";
    frame.style.width = "100%";
    frame.style.height = "100%";
    frame.style.transform = "none";
    return;
  }
  const availW = Math.max(stage.clientWidth - 24, 200);
  const availH = Math.max(stage.clientHeight - 24, 200);
  const scale = Math.min(availW / dev.w, availH / dev.h, 1);
  holder.style.width = dev.w * scale + "px";
  holder.style.height = dev.h * scale + "px";
  frame.style.width = dev.w + "px";
  frame.style.height = dev.h + "px";
  frame.style.transform = `scale(${scale})`;
}

let pvToken = "";
let pvAutoTried = false;

function withErrorHook(code: string, token: string): string {
  const hook =
    "<script>window.addEventListener('error',function(e){parent.postMessage({__eluntraPv:'" + token + "',msg:String(e.message||'エラー')},'*')},true);" +
    "window.addEventListener('unhandledrejection',function(e){parent.postMessage({__eluntraPv:'" + token + "',msg:String((e.reason&&e.reason.message)||e.reason||'非同期エラー')},'*')});</" + "script>";
  const doctype = code.match(/^\s*<!DOCTYPE[^>]*>/i);
  if (doctype) return doctype[0] + hook + code.slice(doctype[0].length);
  const head = code.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return code.slice(0, at) + hook + code.slice(at);
  }
  return hook + code;
}

export function openPreview(a: Artifact): void {
  current = a;
  pvToken = Math.random().toString(36).slice(2);
  pvAutoTried = false;
  $("#pvFix").classList.remove("on");
  ($("#pvFrame") as HTMLIFrameElement).srcdoc = withErrorHook(a.code, pvToken);
  openSheet("previewSheet");
  window.setTimeout(applyDevice, 60);
}

/* ---------- コード表示 ---------- */

export function openCodeView(a: Artifact): void {
  current = a;
  $("#codeViewTitle").textContent = fileNameFor(a.lang);
  const lines = a.code.split("\n");
  $("#codeViewGutter").textContent = lines.map((_, i) => String(i + 1)).join("\n");
  $("#codeViewPre").textContent = a.code;
  $("#codeViewOut").style.display = "none";
  ($("#btnCvRun") as HTMLElement).style.display = a.lang === "javascript" ? "" : "none";
  ($("#btnCvPreview") as HTMLElement).style.display = a.lang === "html" ? "" : "none";
  ($("#btnCvPublish") as HTMLElement).style.display = a.lang === "html" ? "" : "none";
  openSheet("codeViewSheet");
}

/* ---------- 公開 ---------- */

export function openPublish(a: Artifact): void {
  current = a;
  openSheet("publishSheet");
}

async function copyCurrent(): Promise<void> {
  try {
    await navigator.clipboard.writeText(current.code);
    toast("コードをコピーしました");
  } catch {
    toast("コピーできませんでした");
  }
}

/* ---------- 初期化 ---------- */

export function initCodeUI(): void {
  document.addEventListener("click", (e: Event) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cact]");
    if (!btn) return;
    const bar = btn.closest(".code-actions");
    const pre = bar?.previousElementSibling;
    const codeEl = pre?.querySelector("code");
    if (!codeEl) return;
    const artifact: Artifact = {
      code: codeEl.textContent || "",
      lang: normLang(codeEl.getAttribute("data-lang") || "", codeEl.textContent || ""),
    };
    const msgNode = btn.closest(".msg");
    const sess = curSession();
    if (msgNode && sess) {
      const msgIdx = [...document.querySelectorAll("#chatCol .msg")].indexOf(msgNode);
      const blockIdx = [...msgNode.querySelectorAll("pre")].indexOf(pre as HTMLPreElement);
      if (msgIdx >= 0 && blockIdx >= 0) currentRef = { sessId: sess.id, msgIdx, blockIdx };
    }
    const act = btn.getAttribute("data-cact");
    if (act === "preview") openPreview(artifact);
    else if (act === "code") openCodeView(artifact);
    else if (act === "zip") downloadZip(artifact);
    else if (act === "publish") openPublish(artifact);
    else if (act === "copy") {
      current = artifact;
      void copyCurrent();
    } else if (act === "run") {
      openCodeView(artifact);
      void runCurrent();
    }
  });
  document.querySelectorAll<HTMLElement>("[data-dev]").forEach((chip) => {
    chip.addEventListener("click", () => {
      deviceIdx = Number(chip.getAttribute("data-dev"));
      applyDevice();
    });
  });
  $("#btnPvClose").addEventListener("click", () => closeSheet("previewSheet"));
  $("#btnCvClose").addEventListener("click", () => closeSheet("codeViewSheet"));
  $("#btnCvCopy").addEventListener("click", () => void copyCurrent());
  $("#btnCvZip").addEventListener("click", () => downloadZip(current));
  $("#btnCvPreview").addEventListener("click", () => {
    closeSheet("codeViewSheet");
    openPreview(current);
  });
  $("#btnCvPublish").addEventListener("click", () => {
    closeSheet("codeViewSheet");
    openPublish(current);
  });
  $("#btnCvRun").addEventListener("click", () => void runCurrent());
  $("#btnPubClose").addEventListener("click", () => closeSheet("publishSheet"));
  $("#btnPubCopy").addEventListener("click", () => void copyCurrent());
  $("#btnCvFix").addEventListener("click", () => {
    const out = $("#codeViewOut").textContent || "";
    const errMsg = out.startsWith("エラー:") ? out.slice(4).trim() : "実行エラー";
    void autoRepair(errMsg, "js", true);
  });
  $("#btnPvFix").addEventListener("click", () => {
    const msg = $("#pvFixMsg").textContent || "エラー";
    void autoRepair(msg, "preview", true);
  });
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { __eluntraPv?: string; msg?: string } | null;
    if (!d || d.__eluntraPv !== pvToken || !pvToken) return;
    showPvFix(`プレビューでエラー：${d.msg || "不明なエラー"}`);
    if (!pvAutoTried) {
      pvAutoTried = true;
      void autoRepair(d.msg || "不明なエラー", "preview");
    }
  });
}

async function runCurrent(): Promise<void> {
  const out = $("#codeViewOut");
  out.style.display = "block";
  out.textContent = "実行中…";
  $("#codeViewFix").classList.remove("on");
  const result = await runSandboxedJs(current.code);
  out.textContent = result;
  if (result.startsWith("エラー:")) {
    const errMsg = result.slice(4).trim();
    showCvFix(`実行エラー：${errMsg}`);
    void autoRepair(errMsg, "js");
  }
}

function showCvFix(msg: string): void {
  $("#codeViewFixMsg").textContent = msg;
  $("#codeViewFix").classList.add("on");
}

function showPvFix(msg: string): void {
  $("#pvFixMsg").textContent = msg;
  $("#pvFix").classList.add("on");
}


/* ---------- エラー自動修復（Gemini優先でAIに直させる） ---------- */

interface ArtifactRef {
  sessId: string;
  msgIdx: number;
  blockIdx: number;
}
let currentRef: ArtifactRef | null = null;

function extractFixedCode(text: string): string | null {
  const fenced = text.match(/```(?:\w+)?\s*\n([\s\S]*?)```/);
  if (fenced && fenced[1].trim()) return fenced[1].trim();
  const docStart = text.search(/<!DOCTYPE html|<html[\s>]/i);
  if (docStart >= 0) return text.slice(docStart).trim();
  return null;
}

/** 会話内の該当コードブロックを直したコードで置き換える */
function writeBackFixed(newCode: string): boolean {
  if (!currentRef) return false;
  const sess = state.sessions.find((x) => x.id === currentRef?.sessId);
  const msg = sess?.messages[currentRef.msgIdx];
  if (!sess || !msg || msg.role !== "assistant") return false;
  let n = -1;
  const replaced = msg.content.replace(/```(\w*)\s*\n([\s\S]*?)```/g, (whole, lang: string) => {
    n++;
    if (n !== currentRef?.blockIdx) return whole;
    return "```" + (lang || current.lang) + "\n" + newCode + "\n```";
  });
  if (n < currentRef.blockIdx) return false;
  msg.content = replaced;
  persistSessions();
  renderChat();
  return true;
}

let repairing = false;

/**
 * エラーが出たコードをAIに直させる。
 * Geminiのキーが入っていればGeminiを、無ければ現在のプロバイダーを使う。
 */
/** AIにコードを直させる中核処理。直したコードを返す（失敗時はnull） */
async function repairCore(errMsg: string): Promise<string | null> {
  const gemini = PROVIDERS.find((p) => p.id === "gemini");
  const useGemini = gemini && (state.keys.gemini || "").trim();
  const prov = useGemini ? gemini : PROVIDERS.find((p) => p.id === state.conf.provider) ?? gemini;
  if (!prov) return null;
  const key = (state.keys[prov.id] || "").trim();
  if (!key) return null;
  const model = state.conf.models[prov.id] || prov.def || curModel();
  const prompt =
    `次の${current.lang || "コード"}にはエラーがあります。エラーの原因を取り除き、全体が正しく動作する完成コードを、説明なしでコードブロック1つだけで返してください。\n\n` +
    `【エラー】\n${errMsg}\n\n【コード】\n\`\`\`${current.lang}\n${current.code}\n\`\`\``;
  try {
    const full = await callChat(prov, key, model, [{ role: "user", content: prompt }], () => undefined);
    return extractFixedCode(full);
  } catch {
    return null;
  }
}

export async function autoRepair(errMsg: string, source: "js" | "preview", manual = false): Promise<void> {
  if (repairing) return;
  const gemini = PROVIDERS.find((p) => p.id === "gemini");
  const useGemini = gemini && (state.keys.gemini || "").trim();
  const prov = useGemini ? gemini : PROVIDERS.find((p) => p.id === state.conf.provider) ?? gemini;
  if (!prov) return;
  const key = (state.keys[prov.id] || "").trim();
  const status = (t: string): void => {
    if (source === "js") showCvFix(t);
    else showPvFix(t);
  };
  if (!key) {
    status(`修復には${prov.name}のキー設定が必要です。対処：設定でキーを貼ってから「AIで直す」を押してください。`);
    return;
  }
  repairing = true;
  status(`エラーを検知しました。${prov.name}で自動修復中…`);
  try {
    const fixed = await repairCore(errMsg);
    if (!fixed) {
      status("AIで直せませんでした。通信とキー設定を確認して、「AIで直す」でもう一度お試しください。");
      return;
    }
    current = { code: fixed, lang: current.lang };
    writeBackFixed(fixed);
    if (source === "js") {
      $("#codeViewPre").textContent = fixed;
      $("#codeViewGutter").textContent = fixed.split("\n").map((_, i) => String(i + 1)).join("\n");
      status("直しました。再実行します。");
      repairing = false;
      await runCurrentAfterRepair();
    } else {
      pvToken = Math.random().toString(36).slice(2);
      pvAutoTried = true;
      ($("#pvFrame") as HTMLIFrameElement).srcdoc = withErrorHook(fixed, pvToken);
      status("直しました。プレビューを更新しました。");
      window.setTimeout(() => $("#pvFix").classList.remove("on"), 2600);
    }
    toast("エラーを自動修復しました");
  } finally {
    repairing = false;
  }
}

/* ---------- 生成後の自動検証（High / Super high） ---------- */

async function checkArtifact(code: string, lang: string): Promise<string | null> {
  if (lang === "javascript" || lang === "js") {
    const r = await runSandboxedJs(code);
    return r.startsWith("エラー:") ? r.slice(4).trim() : null;
  }
  if (lang === "html") {
    return await new Promise<string | null>((resolve) => {
      const token = Math.random().toString(36).slice(2);
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.style.display = "none";
      let done = false;
      const onMsg = (e: MessageEvent): void => {
        const d = e.data as { __eluntraPv?: string; msg?: string } | null;
        if (d && d.__eluntraPv === token) finish(d.msg || "エラー");
      };
      const finish = (v: string | null): void => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        iframe.remove();
        resolve(v);
      };
      const timer = window.setTimeout(() => finish(null), 1600);
      window.addEventListener("message", onMsg);
      iframe.srcdoc = withErrorHook(code, token);
      document.body.appendChild(iframe);
    });
  }
  return null;
}

/** 生成されたコードを裏で実行チェックし、エラーがあれば最大maxFix回までAI修復する */
export async function verifyAndRepair(sessId: string, msgIdx: number, maxFix: number): Promise<void> {
  const sess = state.sessions.find((x) => x.id === sessId);
  const msg = sess?.messages[msgIdx];
  if (!sess || !msg || msg.role !== "assistant") return;
  const m = msg.content.match(/```(\w*)\s*\n([\s\S]*?)```/);
  if (!m) return;
  let code = m[2];
  const lang = normLang(m[1] || "", code);
  if (lang !== "javascript" && lang !== "js" && lang !== "html") return;
  for (let attempt = 0; attempt <= maxFix; attempt++) {
    const err = await checkArtifact(code, lang);
    if (!err) {
      if (attempt > 0) toast("コードを自動チェックし、修復しました");
      return;
    }
    if (attempt === maxFix) return;
    current = { code, lang };
    currentRef = { sessId, msgIdx, blockIdx: 0 };
    const fixed = await repairCore(err);
    if (!fixed) return;
    current = { code: fixed, lang };
    writeBackFixed(fixed);
    code = fixed;
  }
}

async function runCurrentAfterRepair(): Promise<void> {
  const out = $("#codeViewOut");
  out.style.display = "block";
  const result = await runSandboxedJs(current.code);
  out.textContent = result;
  if (result.startsWith("エラー:")) {
    showCvFix(`まだエラーが出ています：${result.slice(4).trim()}（「AIでエラーを直す」でもう一度試せます）`);
  } else {
    $("#codeViewFix").classList.remove("on");
  }
}
