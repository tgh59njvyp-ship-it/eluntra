/* ZIPダウンロード（Developer v7.2.8）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/zip-download.test.mjs
   buildZipBytes の出力を、独立実装のリーダー（中央ディレクトリ解析＋
   テーブルなしビット演算CRC32）で読み戻して検証する。 */

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const { buildZipBytes, zipFileNameForProject } = bundle.filesMod;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

/* ---------- 独立リーダー（検証専用） ---------- */

// テーブルを使わないビット演算CRC32（実装を書き分けて相互検証する）
function crc32Bitwise(data) {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD は末尾（コメントなし前提で最終22バイト）
  const eocd = bytes.length - 22;
  if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error("EOCD署名が見つからない");
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (cdOffset + cdSize !== eocd) throw new Error("中央ディレクトリの位置・サイズが合わない");
  const dec = new TextDecoder("utf-8");
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("中央ディレクトリ署名が合わない");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ローカルヘッダから実データを取る
    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ローカルヘッダ署名が合わない");
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + size);
    entries.push({ name, flags, method, crc, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (p !== eocd) throw new Error("中央ディレクトリの終端が合わない");
  return entries;
}

/* ============ A: 往復（日本語名・入れ子パス・内容一致） ============ */
group("A: ZIP往復");
{
  const files = {
    "index.html": "<!doctype html>\n<title>テスト</title>\n",
    "src/アプリ.ts": "export const 名前 = '値';\n",
    "日本語フォルダ/メモ.md": "# メモ\nこれはテストです。\n",
    "src/deep/nested/file.txt": "nested\n",
  };
  const zip = buildZipBytes(files);
  ok(zip instanceof Uint8Array && zip.length > 22, "バイト列が生成される");
  const entries = readZip(zip);
  ok(entries.length === 4, `エントリ数が一致（${entries.length}）`);
  const enc = new TextEncoder();
  for (const [name, content] of Object.entries(files)) {
    const e = entries.find((x) => x.name === name);
    ok(!!e, `エントリがある: ${name}`);
    if (!e) continue;
    ok(e.method === 0, `STORE方式: ${name}`);
    ok((e.flags & 0x0800) !== 0, `UTF-8フラグが立つ: ${name}`);
    const want = enc.encode(content);
    ok(e.size === want.length, `サイズ一致: ${name}`);
    ok(e.data.length === want.length && e.data.every((b, i) => b === want[i]), `内容がバイト一致: ${name}`);
    ok(e.crc === crc32Bitwise(want), `CRC32一致（独立計算）: ${name}`);
    ok(new TextDecoder("utf-8").decode(e.data) === content, `文字列として往復: ${name}`);
  }
}

/* ============ B: 空・単一ファイル ============ */
group("B: 境界ケース");
{
  const empty = readZip(buildZipBytes({}));
  ok(empty.length === 0, "空マップはエントリ0件の妥当なZIP");
  const single = readZip(buildZipBytes({ "a.txt": "" }));
  ok(single.length === 1 && single[0].size === 0 && single[0].crc === 0, "空ファイルも入る");
  const big = readZip(buildZipBytes({ "big.txt": "あ".repeat(50000) }));
  ok(big.length === 1 && big[0].data.length === 150000 && big[0].crc === crc32Bitwise(big[0].data), "大きめの内容でも壊れない");
}

/* ============ C: ファイル名サニタイズ ============ */
group("C: zipFileNameForProject");
{
  ok(zipFileNameForProject("マイプロジェクト") === "マイプロジェクト.zip", "日本語名はそのまま");
  ok(zipFileNameForProject("a/b\\c:d*e?f\"g<h>i|j") === "abcdefghij.zip", "使用不可文字と区切りを除去");
  ok(zipFileNameForProject("") === "project.zip", "空名は project.zip");
  ok(zipFileNameForProject("   ") === "project.zip", "空白のみは project.zip");
  ok(zipFileNameForProject("...") === "project.zip", "ドットのみは project.zip");
  ok(zipFileNameForProject("..隠し名") === "隠し名.zip", "先頭ドットを除去");
  const n = zipFileNameForProject("x".repeat(200));
  ok(n.endsWith(".zip") && n.length <= 84, "長すぎる名前は切り詰める");
}

console.log(`\n==== 結果: ${pass} pass / ${fail} fail ====`);
if (failures.length) { console.log("失敗:", failures.join(" / ")); process.exit(1); }
