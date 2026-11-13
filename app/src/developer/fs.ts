/* Playgrounds: プロジェクトファイルシステム（純粋関数層）
   DOM・Reactに依存しない。単体テスト（node）から直接駆動できる。
   永続化は eluntra_dev_projects（localStorage）にプロジェクト配列をJSONで保存する。 */

export interface GhLink {
  owner: string;
  repo: string;
  branch: string;
  /** 読み込み時点のHEADコミットSHA */
  headSha: string;
  /** 読み込み時点のファイル内容（変更検出の基準） */
  baseFiles: Record<string, string>;
}

export interface ChangeLogEntry {
  at: number;
  path: string;
  kind: "create" | "edit" | "delete" | "rename";
  source: "user" | "ai" | "github";
  detail?: string;
}

export interface DevProject {
  id: string;
  name: string;
  files: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  github?: GhLink;
  changeLog: ChangeLogEntry[];
}

export const DEV_PROJECTS_LS = "eluntra_dev_projects";
export const DEV_ACTIVE_LS = "eluntra_dev_active_project";

export function devUid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ---------- パス操作 ---------- */

/** パスを正規化する（先頭/末尾スラッシュ除去、//圧縮、. と .. の解決） */
export function normalizePath(p: string): string {
  const parts = (p || "").replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

export function listPaths(files: Record<string, string>): string[] {
  return Object.keys(files).sort((a, b) => a.localeCompare(b));
}

/** ファイル群からフォルダ一覧（パス接頭辞）を導出する */
export function foldersOf(files: Record<string, string>): string[] {
  const set = new Set<string>();
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function isFolder(files: Record<string, string>, path: string): boolean {
  const prefix = normalizePath(path) + "/";
  return Object.keys(files).some((k) => k.startsWith(prefix));
}

export function exists(files: Record<string, string>, path: string): boolean {
  const p = normalizePath(path);
  return p in files || isFolder(files, p);
}

/* ---------- ファイル操作（いずれも新しい Record を返す純粋関数） ---------- */

export function createFile(files: Record<string, string>, path: string, content = ""): Record<string, string> {
  const p = normalizePath(path);
  if (!p) throw new Error("パスが空です");
  if (p in files) throw new Error(`すでに存在します: ${p}`);
  return { ...files, [p]: content };
}

export function writeFile(files: Record<string, string>, path: string, content: string): Record<string, string> {
  const p = normalizePath(path);
  if (!p) throw new Error("パスが空です");
  return { ...files, [p]: content };
}

/** ファイルまたはフォルダ（接頭辞一致）を削除する */
export function deletePath(files: Record<string, string>, path: string): Record<string, string> {
  const p = normalizePath(path);
  const out: Record<string, string> = {};
  const prefix = p + "/";
  for (const [k, v] of Object.entries(files)) {
    if (k === p || k.startsWith(prefix)) continue;
    out[k] = v;
  }
  if (Object.keys(out).length === Object.keys(files).length) throw new Error(`存在しません: ${p}`);
  return out;
}

/** ファイルまたはフォルダの名前変更／移動 */
export function renamePath(files: Record<string, string>, from: string, to: string): Record<string, string> {
  const f = normalizePath(from);
  const t = normalizePath(to);
  if (!f || !t) throw new Error("パスが空です");
  if (f === t) return files;
  if (t in files) throw new Error(`移動先にすでに存在します: ${t}`);
  const out: Record<string, string> = {};
  let moved = false;
  const prefix = f + "/";
  for (const [k, v] of Object.entries(files)) {
    if (k === f) {
      out[t] = v;
      moved = true;
    } else if (k.startsWith(prefix)) {
      out[t + "/" + k.slice(prefix.length)] = v;
      moved = true;
    } else {
      out[k] = v;
    }
  }
  if (!moved) throw new Error(`存在しません: ${f}`);
  return out;
}

/** 正確一致の置換。見つからない／複数ヒット（replaceAll=false）なら例外 */
export function applyExactEdit(content: string, oldStr: string, newStr: string, replaceAll = false): string {
  if (!oldStr) throw new Error("置換元の文字列が空です");
  const first = content.indexOf(oldStr);
  if (first < 0) throw new Error("置換元の文字列が見つかりませんでした");
  if (!replaceAll && content.indexOf(oldStr, first + 1) >= 0) {
    throw new Error("置換元の文字列が複数箇所にあります。より長い範囲を指定するか replaceAll を使ってください");
  }
  return replaceAll ? content.split(oldStr).join(newStr) : content.slice(0, first) + newStr + content.slice(first + oldStr.length);
}

/* ---------- 検索 ---------- */

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export function searchFiles(files: Record<string, string>, query: string, maxHits = 200): SearchHit[] {
  const q = (query || "").trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  for (const path of listPaths(files)) {
    const lines = files[path].split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(q)) {
        hits.push({ path, line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}

/* ---------- 差分（行単位LCS） ---------- */

export type DiffLineType = "same" | "add" | "del";
export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

const DIFF_MAX_LINES = 3000;

/** 行単位の差分を返す。大きすぎる場合は単純比較にフォールバックする */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText === "" ? [] : oldText.split("\n");
  const b = newText === "" ? [] : newText.split("\n");
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES || a.length * b.length > 4_000_000) {
    const out: DiffLine[] = [];
    a.forEach((t, i) => out.push({ type: "del", text: t, oldNo: i + 1 }));
    b.forEach((t, i) => out.push({ type: "add", text: t, newNo: i + 1 }));
    return out;
  }
  // LCS テーブル
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i], oldNo: i + 1 });
      i++;
    } else {
      out.push({ type: "add", text: b[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < m) {
    out.push({ type: "del", text: a[i], oldNo: i + 1 });
    i++;
  }
  while (j < n) {
    out.push({ type: "add", text: b[j], newNo: j + 1 });
    j++;
  }
  return out;
}

export function diffStat(oldText: string, newText: string): { added: number; removed: number } {
  const d = diffLines(oldText, newText);
  return {
    added: d.filter((l) => l.type === "add").length,
    removed: d.filter((l) => l.type === "del").length,
  };
}

/* ---------- Undo / Redo（ファイル単位の履歴） ---------- */

export class UndoManager {
  private undoStacks = new Map<string, string[]>();
  private redoStacks = new Map<string, string[]>();
  private cap: number;

  constructor(cap = 60) {
    this.cap = cap;
  }

  /** 編集前の内容を積む（内容が変わらない場合は何もしない） */
  push(path: string, before: string, current: string): void {
    if (before === current) return;
    const st = this.undoStacks.get(path) || [];
    if (st[st.length - 1] === before) return;
    st.push(before);
    while (st.length > this.cap) st.shift();
    this.undoStacks.set(path, st);
    this.redoStacks.set(path, []);
  }

  undo(path: string, current: string): string | null {
    const st = this.undoStacks.get(path) || [];
    const prev = st.pop();
    if (prev === undefined) return null;
    const redo = this.redoStacks.get(path) || [];
    redo.push(current);
    this.redoStacks.set(path, redo);
    return prev;
  }

  redo(path: string, current: string): string | null {
    const st = this.redoStacks.get(path) || [];
    const next = st.pop();
    if (next === undefined) return null;
    const undo = this.undoStacks.get(path) || [];
    undo.push(current);
    this.undoStacks.set(path, undo);
    return next;
  }

  canUndo(path: string): boolean {
    return (this.undoStacks.get(path) || []).length > 0;
  }

  canRedo(path: string): boolean {
    return (this.redoStacks.get(path) || []).length > 0;
  }

  clear(): void {
    this.undoStacks.clear();
    this.redoStacks.clear();
  }
}

/* ---------- AIツール層（ファイル操作部分。純粋関数） ---------- */

export interface FsChange {
  path: string;
  kind: "create" | "edit" | "delete";
  before: string | null;
  after: string | null;
}

export interface FsToolResult {
  files: Record<string, string>;
  output: string;
  change?: FsChange;
}

/** fs系ツールをファイル集合に対して実行する。失敗時は例外（呼び出し側でモデルへ返す） */
export function runFsTool(files: Record<string, string>, tool: string, args: Record<string, string>): FsToolResult {
  switch (tool) {
    case "fs_list": {
      const paths = listPaths(files);
      const folders = foldersOf(files);
      const lines = [
        ...folders.map((f) => `${f}/`),
        ...paths.map((p) => `${p} (${files[p].length} bytes)`),
      ];
      return { files, output: lines.join("\n") || "（ファイルがありません）" };
    }
    case "fs_read": {
      const p = normalizePath(args.path || "");
      if (!(p in files)) throw new Error(`ファイルが存在しません: ${p}`);
      const content = files[p];
      const max = 12000;
      return {
        files,
        output: content.length > max ? content.slice(0, max) + `\n…（以下省略。全 ${content.length} 文字）` : content,
      };
    }
    case "fs_write": {
      const p = normalizePath(args.path || "");
      const content = args.content ?? "";
      const before = p in files ? files[p] : null;
      if (before !== null && before === content) {
        // 現在の内容とバイト単位で同一の再送: 変更として記録せず、保存済みであることだけを返す。
        // fs_write_many 経由でも同じ扱いになり、同一アイテムだけが自動でスキップされる（v7.2.13）
        return { files, output: `${p} はすでに同じ内容で保存済みです（変更はありませんでした）` };
      }
      return {
        files: writeFile(files, p, content),
        output: before === null ? `作成しました: ${p}（${content.length} 文字）` : `上書きしました: ${p}（${content.length} 文字）`,
        change: { path: p, kind: before === null ? "create" : "edit", before, after: content },
      };
    }
    case "fs_append": {
      // 末尾への追記。無ければ新規作成として扱う。長いファイルを分割して送るための土台（v7.2.12）
      const p = normalizePath(args.path || "");
      const content = args.content ?? "";
      const before = p in files ? files[p] : null;
      const after = (before ?? "") + content;
      return {
        files: writeFile(files, p, after),
        output:
          before === null
            ? `作成しました（追記）: ${p}（${content.length} 文字）`
            : `追記しました: ${p}（${content.length} 文字追記、全 ${after.length} 文字）`,
        change: { path: p, kind: before === null ? "create" : "edit", before, after },
      };
    }
    case "fs_edit": {
      const p = normalizePath(args.path || "");
      if (!(p in files)) throw new Error(`ファイルが存在しません: ${p}`);
      const before = files[p];
      const after = applyExactEdit(before, args.old ?? "", args.new ?? "", args.replaceAll === "true");
      return {
        files: writeFile(files, p, after),
        output: `編集しました: ${p}`,
        change: { path: p, kind: "edit", before, after },
      };
    }
    case "fs_delete": {
      const p = normalizePath(args.path || "");
      if (!(p in files)) throw new Error(`ファイルが存在しません: ${p}`);
      const before = files[p];
      return {
        files: deletePath(files, p),
        output: `削除しました: ${p}`,
        change: { path: p, kind: "delete", before, after: null },
      };
    }
    case "code_search": {
      const hits = searchFiles(files, args.query || "");
      return {
        files,
        output:
          hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n").slice(0, 8000) || "一致する箇所はありませんでした",
      };
    }
    default:
      throw new Error(`未知のファイルツールです: ${tool}`);
  }
}

/* ---------- 一括ツール（API呼び出し回数を抑えるためのバッチ操作） ---------- */

export interface FsWriteManyResult {
  files: Record<string, string>;
  changes: FsChange[];
  output: string;
}

/** 複数ファイルを1回のツール呼び出しでまとめて書き込む。各ファイルの変更は個別に記録する */
export function runFsWriteMany(
  files: Record<string, string>,
  items: Array<{ path: string; content: string }>,
): FsWriteManyResult {
  if (!items.length) throw new Error("fs_write_many: files が空です");
  let cur = files;
  const changes: FsChange[] = [];
  const lines: string[] = [];
  for (const item of items) {
    const r = runFsTool(cur, "fs_write", { path: item.path || "", content: item.content ?? "" });
    cur = r.files;
    if (r.change) changes.push(r.change);
    lines.push(r.output);
  }
  return { files: cur, changes, output: lines.join("\n") };
}

export interface FsReadManyResult {
  output: string;
  read: string[];
  missing: string[];
}

/** 複数ファイルを1回でまとめて読む。存在しないファイルは例外にせず、その旨を結果に含める */
export function runFsReadMany(files: Record<string, string>, paths: string[]): FsReadManyResult {
  if (!paths.length) throw new Error("fs_read_many: paths が空です");
  const read: string[] = [];
  const missing: string[] = [];
  const chunks: string[] = [];
  let total = 0;
  const TOTAL_MAX = 20000;
  const PER_FILE_MAX = 8000;
  for (const raw of paths) {
    const p = normalizePath(raw || "");
    if (!(p in files)) {
      missing.push(p);
      chunks.push(`===== ${p} =====\n（ファイルが存在しません）`);
      continue;
    }
    read.push(p);
    let content = files[p];
    if (content.length > PER_FILE_MAX) content = content.slice(0, PER_FILE_MAX) + `\n…（以下省略。全 ${files[p].length} 文字）`;
    if (total + content.length > TOTAL_MAX) {
      chunks.push(`===== ${p} =====\n（全体の上限に達したため省略）`);
      continue;
    }
    total += content.length;
    chunks.push(`===== ${p} =====\n${content}`);
  }
  return { output: chunks.join("\n\n"), read, missing };
}

/** 変更を取り消す（Undo）ための逆操作 */
export function revertChange(files: Record<string, string>, change: FsChange): Record<string, string> {
  if (change.kind === "create") {
    return change.path in files ? deletePath(files, change.path) : files;
  }
  // edit / delete は before の内容に戻す
  return writeFile(files, change.path, change.before ?? "");
}

/* ---------- テンプレート ---------- */

export interface ProjectTemplate {
  id: string;
  name: string;
  desc: string;
  files: () => Record<string, string>;
}

const STATIC_FILES: Record<string, string> = {
  "index.html": [
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>マイサイト</title>",
    '<link rel="stylesheet" href="style.css">',
    "</head>",
    "<body>",
    "<main>",
    "<h1>こんにちは</h1>",
    "<p>これは静的サイトのテンプレートです。ファイルツリーから編集できます。</p>",
    '<button id="btn" type="button">クリック</button>',
    '<p id="out"></p>',
    "</main>",
    '<script src="main.js"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n"),
  "style.css": [
    "body { font-family: system-ui, sans-serif; margin: 2rem; color: #0f1e3a; }",
    "h1 { font-size: 2rem; }",
    "button { background: #2e7cf6; color: #fff; border: none; border-radius: 999px; padding: 0.6rem 1.4rem; font-size: 1rem; cursor: pointer; }",
    "",
  ].join("\n"),
  "main.js": [
    'let count = 0;',
    'document.getElementById("btn").addEventListener("click", () => {',
    "  count += 1;",
    '  document.getElementById("out").textContent = `クリック回数: ${count}`;',
    "});",
    "",
  ].join("\n"),
};

const REACT_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    {
      name: "eluntra-app",
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
      dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
      devDependencies: { "@vitejs/plugin-react": "^4.3.4", typescript: "^5.6.3", vite: "^5.4.11" },
    },
    null,
    2,
  ) + "\n",
  "index.html": [
    "<!DOCTYPE html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>React アプリ</title>",
    "</head>",
    "<body>",
    '<div id="root"></div>',
    '<script type="module" src="/src/main.tsx"></script>',
    "</body>",
    "</html>",
    "",
  ].join("\n"),
  "vite.config.ts": [
    'import { defineConfig } from "vite";',
    'import react from "@vitejs/plugin-react";',
    "",
    "export default defineConfig({ plugins: [react()] });",
    "",
  ].join("\n"),
  "tsconfig.json": JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        skipLibCheck: true,
        isolatedModules: true,
        noEmit: true,
      },
      include: ["src", "vite.config.ts"],
    },
    null,
    2,
  ) + "\n",
  "src/main.tsx": [
    'import React from "react";',
    'import { createRoot } from "react-dom/client";',
    'import App from "./App";',
    'import "./style.css";',
    "",
    'createRoot(document.getElementById("root")!).render(',
    "  <React.StrictMode>",
    "    <App />",
    "  </React.StrictMode>,",
    ");",
    "",
  ].join("\n"),
  "src/App.tsx": [
    'import { useState } from "react";',
    "",
    "export default function App() {",
    "  const [count, setCount] = useState(0);",
    "  return (",
    "    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem', color: '#0f1e3a' }}>",
    "      <h1>React + TypeScript</h1>",
    "      <p>Vite の開発サーバーでプレビューできます。</p>",
    "      <button",
    "        type=\"button\"",
    "        onClick={() => setCount((c) => c + 1)}",
    "        style={{ background: '#2e7cf6', color: '#fff', border: 'none', borderRadius: 999, padding: '0.6rem 1.4rem', cursor: 'pointer' }}",
    "      >",
    "        カウント: {count}",
    "      </button>",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/style.css": "body { margin: 0; }\n",
};

export const TEMPLATES: ProjectTemplate[] = [
  { id: "empty", name: "空のプロジェクト", desc: "ファイルなしで開始", files: () => ({}) },
  { id: "static", name: "静的サイト", desc: "index.html / style.css / main.js", files: () => ({ ...STATIC_FILES }) },
  { id: "react", name: "React + TypeScript", desc: "Vite構成。ターミナルで npm install → npm run dev", files: () => ({ ...REACT_FILES }) },
];

export function createProject(name: string, templateId: string): DevProject {
  const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
  const now = Date.now();
  return {
    id: devUid(),
    name: name.trim() || "新規プロジェクト",
    files: tpl.files(),
    createdAt: now,
    updatedAt: now,
    changeLog: [{ at: now, path: "", kind: "create", source: "user", detail: `テンプレート「${tpl.name}」で作成` }],
  };
}

/* ---------- 永続化（localStorage。node環境ではメモリ代替） ---------- */

let memFallback: DevProject[] | null = null;

export function loadProjects(): DevProject[] {
  try {
    const raw = localStorage.getItem(DEV_PROJECTS_LS);
    if (!raw) return [];
    const arr = JSON.parse(raw) as DevProject[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return memFallback || [];
  }
}

export function saveProjects(projects: DevProject[]): void {
  memFallback = projects;
  try {
    localStorage.setItem(DEV_PROJECTS_LS, JSON.stringify(projects));
  } catch {
    /* 容量超過などは無視（メモリ上は保持） */
  }
}

export function appendChangeLog(p: DevProject, entry: ChangeLogEntry): DevProject {
  return { ...p, changeLog: [entry, ...(p.changeLog || [])].slice(0, 100), updatedAt: Date.now() };
}

/* ---------- 静的プレビュー用ドキュメント組み立て ---------- */

/** プロジェクトの index.html に、参照している style.css / main.js 等をインライン化した表示用HTMLを作る */
export function buildStaticPreview(files: Record<string, string>, entry = "index.html"): string | null {
  const html = files[entry];
  if (html == null) return null;
  let doc = html;
  doc = doc.replace(/<link[^>]*href=["']([^"']+)["'][^>]*>/gi, (m, href: string) => {
    const key = normalizePath(href.replace(/^\.\//, "").replace(/^\//, ""));
    if (key in files && key.endsWith(".css")) return `<style>\n${files[key]}\n</style>`;
    return m;
  });
  doc = doc.replace(/<script[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi, (m, src: string) => {
    const key = normalizePath(src.replace(/^\.\//, "").replace(/^\//, ""));
    if (key in files && /\.m?js$/.test(key)) return `<script>\n${files[key]}\n</script>`;
    return m;
  });
  return doc;
}
