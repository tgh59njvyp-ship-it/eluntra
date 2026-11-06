import { runSandboxedJs } from "./agent";
import { closeSheet, normLang, openSheet } from "./render";
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

export function openPreview(a: Artifact): void {
  current = a;
  ($("#pvFrame") as HTMLIFrameElement).srcdoc = a.code;
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
}

async function runCurrent(): Promise<void> {
  const out = $("#codeViewOut");
  out.style.display = "block";
  out.textContent = "実行中…";
  const result = await runSandboxedJs(current.code);
  out.textContent = result;
}

