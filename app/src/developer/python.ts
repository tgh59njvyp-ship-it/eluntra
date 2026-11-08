/* Eluntra Developer: Python実行（Pyodide / CPython の WASM 版）
   ランタイムは自サイトの /pyodide/ から読み込む（外部CDNに依存しない）。
   プロジェクトファイルを Pyodide の FS（/project）へ同期してから実行し、
   実行後に作成・変更・削除されたファイルをプロジェクトへ反映する。
   制約: ソケット・スレッドは使えない。C拡張パッケージは wheel があるものだけ。
   実行はメインスレッドで行うため、無限ループは画面を止める（Pyodide の仕様）。 */

import { normalizePath } from "./fs";

export type PyState = "idle" | "loading" | "ready" | "error";

export interface PyChange {
  path: string;
  /** null は削除 */
  content: string | null;
}

export interface PyRunResult {
  output: string;
  error?: string;
  changes: PyChange[];
}

const PROJECT_DIR = "/project";
const MAX_SYNC_BYTES = 512 * 1024;
const SKIP_DIRS = new Set(["__pycache__", ".git", "node_modules"]);

type OutputListener = (chunk: string) => void;
type StateListener = () => void;

/* Pyodide の型は最小限だけ自前で定義する（公式型は巨大で、使う範囲が限られるため） */
interface PyodideFS {
  mkdir(path: string): void;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
}
interface PyodideApi {
  FS: PyodideFS;
  runPythonAsync(code: string): Promise<unknown>;
  runPython(code: string): unknown;
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  loadPackage(names: string | string[]): Promise<void>;
  globals: { set(name: string, value: unknown): void };
}

export function pyodideIndexURL(): string {
  if (typeof document !== "undefined") return new URL("pyodide/", document.baseURI).toString();
  return "/pyodide/";
}

class PyodideService {
  state: PyState = "idle";
  errorReason = "";
  version = "";
  private py: PyodideApi | null = null;
  private loadPromise: Promise<PyodideApi> | null = null;
  private outBuffer = "";
  private streamTo: OutputListener | null = null;
  private stateListeners = new Set<StateListener>();

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  private setState(s: PyState, reason = ""): void {
    this.state = s;
    this.errorReason = reason;
    this.stateListeners.forEach((fn) => fn());
  }

  get available(): boolean {
    return this.state === "ready";
  }

  async ensureLoad(): Promise<PyodideApi> {
    if (this.py) return this.py;
    if (this.loadPromise) return this.loadPromise;
    this.setState("loading");
    this.loadPromise = (async () => {
      const { loadPyodide } = await import("pyodide");
      const py = (await loadPyodide({ indexURL: pyodideIndexURL() })) as unknown as PyodideApi;
      py.setStdout({
        batched: (s: string) => {
          const line = s + "\n";
          this.outBuffer += line;
          this.streamTo?.(line);
        },
      });
      py.setStderr({
        batched: (s: string) => {
          const line = s + "\n";
          this.outBuffer += line;
          this.streamTo?.(line);
        },
      });
      this.version = String(py.runPython("import sys; sys.version.split()[0]") ?? "");
      this.py = py;
      this.setState("ready");
      return py;
    })();
    try {
      return await this.loadPromise;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState("error", `Pyodide（Python）の読み込みに失敗しました: ${msg}`);
      this.loadPromise = null;
      throw e;
    }
  }

  /* ---------- FS 同期 ---------- */

  private removeRecursive(fs: PyodideFS, path: string): void {
    let mode: number;
    try {
      mode = fs.stat(path).mode;
    } catch {
      return;
    }
    if (fs.isDir(mode)) {
      for (const name of fs.readdir(path)) {
        if (name === "." || name === "..") continue;
        this.removeRecursive(fs, `${path}/${name}`);
      }
      try {
        fs.rmdir(path);
      } catch {
        /* ignore */
      }
    } else {
      try {
        fs.unlink(path);
      } catch {
        /* ignore */
      }
    }
  }

  /** プロジェクトのファイルを /project へ書き出す（前回分は作り直す） */
  private syncIn(py: PyodideApi, files: Record<string, string>): void {
    const fs = py.FS;
    this.removeRecursive(fs, PROJECT_DIR);
    try {
      fs.mkdir(PROJECT_DIR);
    } catch {
      /* 既に在る場合 */
    }
    for (const [path, content] of Object.entries(files)) {
      const p = normalizePath(path);
      if (!p || p.split("/").some((seg) => SKIP_DIRS.has(seg))) continue;
      if (content.length > MAX_SYNC_BYTES) continue;
      const parts = p.split("/");
      let dir = PROJECT_DIR;
      for (let i = 0; i < parts.length - 1; i++) {
        dir += "/" + parts[i];
        try {
          fs.mkdir(dir);
        } catch {
          /* 既に在る場合 */
        }
      }
      fs.writeFile(`${PROJECT_DIR}/${p}`, content);
    }
  }

  /** /project 配下のテキストファイルをすべて読む（相対パス → 内容） */
  private snapshot(py: PyodideApi): Map<string, string> {
    const fs = py.FS;
    const out = new Map<string, string>();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const walk = (dir: string, rel: string): void => {
      let names: string[];
      try {
        names = fs.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name === "." || name === ".." || SKIP_DIRS.has(name)) continue;
        const full = `${dir}/${name}`;
        const relPath = rel ? `${rel}/${name}` : name;
        try {
          const st = fs.stat(full);
          if (fs.isDir(st.mode)) {
            walk(full, relPath);
          } else {
            const bytes = fs.readFile(full);
            if (bytes.length > MAX_SYNC_BYTES) continue;
            try {
              out.set(relPath, decoder.decode(bytes));
            } catch {
              /* バイナリはプロジェクトへ同期しない */
            }
          }
        } catch {
          /* 読めないファイルは無視 */
        }
      }
    };
    walk(PROJECT_DIR, "");
    return out;
  }

  /* ---------- 実行 ---------- */

  /**
   * Pythonコードを実行する。実行前後でプロジェクトファイルを同期し、差分を返す。
   * globals は Pyodide 既定の __main__ を使うため、連続実行で変数が保持される（REPL的）。
   */
  async runCode(
    files: Record<string, string>,
    code: string,
    opts: { argv?: string[]; onOutput?: OutputListener } = {},
  ): Promise<PyRunResult> {
    const py = await this.ensureLoad();
    this.syncIn(py, files);
    const before = this.snapshot(py);
    py.runPython(`import os, sys; os.chdir(${JSON.stringify(PROJECT_DIR)}); sys.argv = ${JSON.stringify(opts.argv ?? ["python"])}`);
    this.outBuffer = "";
    this.streamTo = opts.onOutput ?? null;
    let error: string | undefined;
    try {
      await py.runPythonAsync(code);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.streamTo = null;
    }
    const after = this.snapshot(py);
    const changes: PyChange[] = [];
    for (const [path, content] of after) {
      if (before.get(path) !== content) changes.push({ path, content });
    }
    for (const path of before.keys()) {
      if (!after.has(path)) changes.push({ path, content: null });
    }
    return { output: this.outBuffer, error, changes };
  }

  /** ファイルの内容を __main__ として実行する */
  async runFile(
    files: Record<string, string>,
    path: string,
    args: string[] = [],
    onOutput?: OutputListener,
  ): Promise<PyRunResult> {
    const p = normalizePath(path);
    const code = files[p];
    if (code == null) {
      return { output: "", error: `ファイルが存在しません: ${p}`, changes: [] };
    }
    return this.runCode(files, code, { argv: [p, ...args], onOutput });
  }

  /** REPL: 式・文を1単位実行する（ファイル同期なし、globals は保持される） */
  async runSnippet(code: string, onOutput?: OutputListener): Promise<{ output: string; error?: string }> {
    const py = await this.ensureLoad();
    this.outBuffer = "";
    this.streamTo = onOutput ?? null;
    let error: string | undefined;
    try {
      // 式の場合は値を表示する（対話コンソール風）
      const trimmed = code.trim();
      const isExpr = !/^(import |from |def |class |for |while |if |try|with |print\(|.*=)/.test(trimmed) && !trimmed.includes("\n");
      if (isExpr) {
        const wrapped = `__eluntra_repr = (${trimmed})\nif __eluntra_repr is not None:\n    print(repr(__eluntra_repr))`;
        await py.runPythonAsync(wrapped);
      } else {
        await py.runPythonAsync(code);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.streamTo = null;
    }
    return { output: this.outBuffer, error };
  }

  /** pip install の代替として micropip を使う（純Pythonパッケージのみ） */
  async pipInstall(packages: string[], onOutput?: OutputListener): Promise<{ output: string; error?: string }> {
    const py = await this.ensureLoad();
    this.outBuffer = "";
    this.streamTo = onOutput ?? null;
    let error: string | undefined;
    try {
      await py.loadPackage("micropip");
      const list = JSON.stringify(packages);
      await py.runPythonAsync(
        `import micropip\nawait micropip.install(${list})`,
      );
      const done = `micropip でインストールしました: ${packages.join(", ")}\n`;
      this.outBuffer += done;
      this.streamTo?.(done);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      this.streamTo = null;
    }
    return { output: this.outBuffer, error };
  }
}

export const pyService = new PyodideService();

/* ---------- コマンド解析（純粋関数。単体テスト対象） ---------- */

export type ParsedTermCommand =
  | { kind: "python-file"; path: string; args: string[] }
  | { kind: "python-code"; code: string }
  | { kind: "python-repl" }
  | { kind: "pip-install"; packages: string[] }
  | { kind: "other" };

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

/** ターミナル入力を分類する。python / pip 系は Pyodide へ、それ以外は WebContainer へ */
export function parsePythonCommand(command: string): ParsedTermCommand {
  const trimmed = command.trim();
  const tokens = tokenize(trimmed);
  if (!tokens.length) return { kind: "other" };
  const head = tokens[0];
  if (head === "pip" || head === "pip3") {
    if (tokens[1] === "install" && tokens.length >= 3) {
      return { kind: "pip-install", packages: tokens.slice(2).filter((t) => !t.startsWith("-")) };
    }
    return { kind: "other" };
  }
  if (head === "python" || head === "python3") {
    if (tokens.length === 1) return { kind: "python-repl" };
    if (tokens[1] === "-c" && tokens.length >= 3) {
      return { kind: "python-code", code: tokens.slice(2).join(" ") };
    }
    if (tokens[1] === "-m") return { kind: "other" };
    if (!tokens[1].startsWith("-")) {
      return { kind: "python-file", path: tokens[1], args: tokens.slice(2) };
    }
    return { kind: "other" };
  }
  return { kind: "other" };
}

export function isPythonCommand(command: string): boolean {
  return parsePythonCommand(command).kind !== "other";
}

/** 実行で生じた変更をプロジェクトのファイル集合へ適用する（純粋関数） */
export function applyPyChanges(
  files: Record<string, string>,
  changes: PyChange[],
): { files: Record<string, string>; touched: string[] } {
  const next = { ...files };
  const touched: string[] = [];
  for (const ch of changes) {
    const p = normalizePath(ch.path);
    if (!p) continue;
    if (ch.content === null) {
      if (p in next) {
        delete next[p];
        touched.push(p);
      }
    } else if (next[p] !== ch.content) {
      next[p] = ch.content;
      touched.push(p);
    }
  }
  return { files: next, touched };
}
