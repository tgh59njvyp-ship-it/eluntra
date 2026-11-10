import type { Attachment } from "./types";

/* ファイル添付：テキスト系は内容を読み、画像はそのまま保持する。
   PDF / DOCX / XLSX は本文抽出ができないため未対応として理由を返す。 */

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|xml|html|css|js|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|yml|yaml|toml|ini|svg)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const UNSUPPORTED_EXT = /\.(pdf|docx|xlsx|pptx|doc|xls|ppt)$/i;

export interface PickResult {
  attachments: Attachment[];
  warnings: string[];
}

export async function readPickedFiles(files: FileList | File[]): Promise<PickResult> {
  const out: Attachment[] = [];
  const warnings: string[] = [];
  for (const f of [...files]) {
    if (IMAGE_EXT.test(f.name) || f.type.startsWith("image/")) {
      if (f.size > 8 * 1024 * 1024) {
        warnings.push(`${f.name}：画像が大きすぎるため添付できません（8MBまで）`);
        continue;
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("read failed"));
        r.readAsDataURL(f);
      });
      out.push({ name: f.name, kind: "image", dataUrl, mime: f.type || "image/png" });
    } else if (UNSUPPORTED_EXT.test(f.name)) {
      warnings.push(`${f.name}：PDF・Office文書は現在未対応です。テキスト形式（.txt / .md等）に変換してから添付してください`);
    } else if (TEXT_EXT.test(f.name) || f.type.startsWith("text/") || f.type === "application/json") {
      const text = await f.text();
      out.push({ name: f.name, kind: "text", text: text.slice(0, 60000) });
    } else {
      warnings.push(`${f.name}：対応していない形式です（テキスト系と画像のみ対応）`);
    }
  }
  return { attachments: out, warnings };
}

/** プロジェクト名から安全なZIPファイル名を作る（パス区切り・使用不可文字を除去） */
export function zipFileNameForProject(name: string): string {
  const cleaned = (name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .trim()
    .slice(0, 80)
    .trim();
  return `${cleaned || "project"}.zip`;
}

/** ZIPバイト列を生成する（store方式・無圧縮、外部ライブラリなし。ファイル名はUTF-8フラグ付き） */
export function buildZipBytes(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (data: Uint8Array): number => {
    let c = 0xffffffff;
    data.forEach((b) => {
      c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    });
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  const push = (arr: Uint8Array[], b: Uint8Array) => arr.push(b);
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const crc = crc32(data);
    const local = [
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
    ];
    local.forEach((b) => push(chunks, b));
    push(chunks, nameBytes);
    push(chunks, data);
    const localLen = local.reduce((a, b) => a + b.length, 0) + nameBytes.length + data.length;
    const cen = [
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
    ];
    cen.forEach((b) => push(central, b));
    push(central, nameBytes);
    offset += localLen;
  }
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const count = Object.keys(files).length;
  const end = [u32(0x06054b50), u16(0), u16(0), u16(count), u16(count), u32(centralSize), u32(offset), u16(0)];
  const all = [...chunks, ...central, ...end];
  const total = all.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(total);
  let pos = 0;
  all.forEach((b) => {
    buf.set(b, pos);
    pos += b.length;
  });
  return buf;
}

/** ZIP生成でコードを保存する（本体チャット／Developer 共用） */
export function downloadZip(files: Record<string, string>, zipName: string): void {
  const buf = buildZipBytes(files);
  const blob = new Blob([buf.buffer as ArrayBuffer], { type: "application/zip" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = zipName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
