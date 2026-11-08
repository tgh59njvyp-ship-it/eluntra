/* Eluntra Developer: WebContainer ラッパー
   ターミナルと開発サーバープレビューの実体。遅延起動し、失敗理由を正直に保持する。
   WebContainer は Node.js のみ（Python等の他言語ランタイムは動かない）。 */

import type { FileSystemTree, WebContainer, WebContainerProcess } from "@webcontainer/api";
import { normalizePath } from "./fs";

export type WcState = "idle" | "booting" | "ready" | "error";

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut?: boolean;
}

type OutputListener = (chunk: string) => void;
type StateListener = () => void;

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[a-zA-Z]|" + String.fromCharCode(27) + "\\][^" + String.fromCharCode(7) + "]*" + String.fromCharCode(7), "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/** Record<path, content> を WebContainer の FileSystemTree に変換する */
export function toFileSystemTree(files: Record<string, string>): FileSystemTree {
  const root: FileSystemTree = {};
  for (const [path, content] of Object.entries(files)) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    if (!parts.length) continue;
    let node: FileSystemTree = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = node[parts[i]] as { directory?: FileSystemTree } | undefined;
      if (!dir || !dir.directory) node[parts[i]] = { directory: {} };
      node = (node[parts[i]] as { directory: FileSystemTree }).directory;
    }
    node[parts[parts.length - 1]] = { file: { contents: content } };
  }
  return root;
}

function splitCommand(command: string): { cmd: string; args: string[] } | null {
  // 簡易トークナイズ（クォート対応）。シェルメタ文字は jsh -c 側で処理する
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  if (!tokens.length) return null;
  return { cmd: tokens[0], args: tokens.slice(1) };
}

const SHELL_META = /[|&;<>`$(){}\\]/;

class WcService {
  state: WcState = "idle";
  errorReason = "";
  private wc: WebContainer | null = null;
  private bootPromise: Promise<WebContainer> | null = null;
  private current: WebContainerProcess | null = null;
  private devServer: WebContainerProcess | null = null;
  previewUrl = "";
  private stateListeners = new Set<StateListener>();
  private previewListeners = new Set<(url: string) => void>();
  private syncTimer: number | null = null;

  onState(fn: StateListener): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  onPreview(fn: (url: string) => void): () => void {
    this.previewListeners.add(fn);
    return () => this.previewListeners.delete(fn);
  }

  private setState(s: WcState, reason = ""): void {
    this.state = s;
    this.errorReason = reason;
    this.stateListeners.forEach((fn) => fn());
  }

  get available(): boolean {
    return this.state === "ready";
  }

  /** 起動する（未起動なら boot、失敗なら理由を保持して例外） */
  async ensureBoot(): Promise<WebContainer> {
    if (this.wc) return this.wc;
    if (this.bootPromise) return this.bootPromise;
    this.setState("booting");
    this.bootPromise = (async () => {
      if (typeof window === "undefined" || !window.crossOriginIsolated) {
        throw new Error(
          "このページが crossOriginIsolated になっていないため、WebContainer を起動できません（サーバーの COOP/COEP ヘッダーが必要です）。",
        );
      }
      const { WebContainer } = await import("@webcontainer/api");
      // 起動が応答しない環境（CDN到達不可など）で「起動中」のまま固まらないよう60秒で打ち切る
      const wc = await Promise.race([
        WebContainer.boot(),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () =>
              reject(
                new Error(
                  "WebContainerの起動が60秒でタイムアウトしました。ネットワーク接続（WebContainerの配信元へアクセスできること）を確認してください。",
                ),
              ),
            60_000,
          ),
        ),
      ]);
      wc.on("server-ready", (_port, url) => {
        this.previewUrl = url;
        this.previewListeners.forEach((fn) => fn(url));
      });
      wc.on("error", (err) => {
        this.setState("error", `WebContainer エラー: ${err.message}`);
      });
      this.wc = wc;
      this.setState("ready");
      return wc;
    })();
    try {
      return await this.bootPromise;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setState("error", msg);
      this.bootPromise = null;
      throw e;
    }
  }

  /** プロジェクト全体をコンテナへマウントする */
  async mountProject(files: Record<string, string>): Promise<void> {
    const wc = await this.ensureBoot();
    await wc.mount(toFileSystemTree(files));
  }

  /** 1ファイルをコンテナへ書き込む（エディタ編集の追随用） */
  async syncFile(path: string, content: string | null): Promise<void> {
    if (!this.wc) return;
    const p = normalizePath(path);
    try {
      if (content === null) {
        await this.wc.fs.rm(p, { force: true });
        return;
      }
      const dir = p.split("/").slice(0, -1).join("/");
      if (dir) await this.wc.fs.mkdir(dir, { recursive: true });
      await this.wc.fs.writeFile(p, content);
    } catch {
      /* コンテナ側の同期失敗はエディタ作業を止めない */
    }
  }

  /** 編集をデバウンスしてコンテナへ送る */
  scheduleSync(path: string, content: string | null): void {
    if (!this.wc) return;
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      void this.syncFile(path, content);
    }, 600);
  }

  private async collect(proc: WebContainerProcess, onOutput: OutputListener | undefined, timeoutMs: number): Promise<ExecResult> {
    let output = "";
    const reader = proc.output.getReader();
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const clean = stripAnsi(value);
        output += clean;
        if (output.length > 200_000) output = output.slice(-200_000);
        onOutput?.(clean);
      }
    })();
    let timedOut = false;
    const exitCode = await Promise.race([
      proc.exit,
      new Promise<null>((resolve) =>
        window.setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            /* ignore */
          }
          resolve(null);
        }, timeoutMs),
      ),
    ]);
    try {
      await Promise.race([pump, new Promise((r) => window.setTimeout(r, 800))]);
    } catch {
      /* ignore */
    }
    return { code: exitCode, output, timedOut };
  }

  /** コマンドを実行する。シェル記法が含まれる場合は jsh -c、なければ直接 spawn */
  async exec(command: string, opts: { timeoutMs?: number; onOutput?: OutputListener } = {}): Promise<ExecResult> {
    const wc = await this.ensureBoot();
    const trimmed = command.trim();
    if (!trimmed) return { code: 0, output: "" };
    let proc: WebContainerProcess;
    if (SHELL_META.test(trimmed)) {
      proc = await wc.spawn("jsh", ["-c", trimmed]);
    } else {
      const parsed = splitCommand(trimmed);
      if (!parsed) return { code: 0, output: "" };
      proc = await wc.spawn(parsed.cmd, parsed.args);
    }
    this.current = proc;
    try {
      return await this.collect(proc, opts.onOutput, opts.timeoutMs ?? 180_000);
    } finally {
      if (this.current === proc) this.current = null;
    }
  }

  /** 開発サーバーを起動する（終了を待たない。URLは server-ready で通知される） */
  async startDevServer(onOutput: OutputListener): Promise<void> {
    const wc = await this.ensureBoot();
    await this.stopDevServer();
    const proc = await wc.spawn("npm", ["run", "dev"]);
    this.devServer = proc;
    void (async () => {
      const reader = proc.output.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        onOutput(stripAnsi(value));
      }
    })().catch(() => undefined);
    void proc.exit.then((code) => {
      onOutput(`\n[開発サーバーが終了しました（code ${code}）]\n`);
      if (this.devServer === proc) this.devServer = null;
    });
  }

  async stopDevServer(): Promise<void> {
    if (this.devServer) {
      try {
        this.devServer.kill();
      } catch {
        /* ignore */
      }
      this.devServer = null;
    }
  }

  get devServerRunning(): boolean {
    return !!this.devServer;
  }

  /** 実行中の単発コマンドを止める */
  stopCurrent(): void {
    if (this.current) {
      try {
        this.current.kill();
      } catch {
        /* ignore */
      }
      this.current = null;
    }
  }
}

export const wcService = new WcService();
