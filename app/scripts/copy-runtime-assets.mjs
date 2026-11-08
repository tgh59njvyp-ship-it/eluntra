/* Eluntra Developer: ランタイムアセットの自己ホスト用コピー
   Pyodide（Python）と sql.js（SQLite）の WASM 等を node_modules から public/ へコピーする。
   外部CDNに依存しないことで、オフライン耐性とローカル検証可能性を確保する。
   prebuild / postinstall で自動実行される。 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const pub = join(root, "public");

function copy(src, dest) {
  if (!existsSync(src)) {
    console.warn(`[runtime-assets] 見つかりません（スキップ）: ${src}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  console.log(`[runtime-assets] ${src.replace(root, ".")} -> ${dest.replace(root, ".")}`);
}

// Pyodide: indexURL が指すディレクトリに必要な一式
const pySrc = join(nm, "pyodide");
const pyDst = join(pub, "pyodide");
for (const f of ["pyodide.asm.wasm", "pyodide.asm.mjs", "python_stdlib.zip", "pyodide-lock.json", "package.json"]) {
  copy(join(pySrc, f), join(pyDst, f));
}

// sql.js: WASM 本体のみ（ローダーは npm import でバンドルされる）
// ブラウザ向けバンドルは sql-wasm-browser.wasm を要求するため両方置く
copy(join(nm, "sql.js", "dist", "sql-wasm.wasm"), join(pub, "sqlite", "sql-wasm.wasm"));
copy(join(nm, "sql.js", "dist", "sql-wasm-browser.wasm"), join(pub, "sqlite", "sql-wasm-browser.wasm"));

console.log("[runtime-assets] done");
