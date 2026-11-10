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

export interface DevServerStartResult {
  /** URL が発行されたらその URL。発行されなかったら "" */
  url: string;
  /** 起動中に集まった出力ログ（末尾） */
  log: string;
  /** 待ち時間内に URL が発行されたか */
  ready: boolean;
  /** 待ち時間内にサーバープロセスが終了していたらその終了コード */
  exitCode: number | null;
}

type OutputListener = (chunk: string) => void;
type StateListener = () => void;

const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[a-zA-Z]|" + String.fromCharCode(27) + "\\][^" + String.fromCharCode(7) + "]*" + String.fromCharCode(7), "g");

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/* ---------- タイムアウト基盤（v7.2.9） ----------
   ターミナル経路の各段階（読み込み／起動／マウント／コマンド開始）に上限を付け、
   「応答しないまま固まる」状態を作らない。値はテストから差し替え可能にする。 */
export const WC_TIMEOUTS = {
  /** @webcontainer/api の動的 import */
  importMs: 60_000,
  /** WebContainer の起動（boot 本体は裏で続くことがあるため呼び出し側のレース上限） */
  bootMs: 60_000,
  /** プロジェクトのマウント */
  mountMs: 60_000,
  /** コマンド／開発サーバーの spawn */
  spawnMs: 30_000,
  /** 1コマンドの実行上限 */
  execMs: 120_000,
  /** 開発サーバーの URL 発行を待つ上限（過ぎてもサーバーは裏で起動を続ける） */
  serverReadyMs: 15_000,
};

/** 段階名つきのタイムアウトエラー。どの段階で止まったかをユーザーへ正直に伝えるために使う */
export class PhaseTimeoutError extends Error {
  readonly phase: string;
  readonly timeoutMs: number;
  constructor(phase: string, timeoutMs: number) {
    super(`${phase}が${Math.max(1, Math.round(timeoutMs / 1000))}秒でタイムアウトしました。`);
    this.name = "PhaseTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/** promise に上限時間を付ける。元の処理は裏で続くことがあるため、呼び出し側は再入に注意する */
export function withTimeout<T>(promise: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PhaseTimeoutError(phase, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** エージェントへ返す「ターミナルが環境レベルで使えない」結果の接頭辞。
    panels が生成し、agent がこの接頭辞で「再試行しても無駄な失敗」を判別する */
export const TERMINAL_UNAVAILABLE_PREFIX = "ターミナル（Node.js）は利用できません";

/** term_exec の結果が「環境レベルでターミナル不可」（起動・マウント・開始の失敗）かどうか。
    コマンド自体のタイムアウトや終了コード非0は、ここには含めない */
export function isTerminalEnvUnavailable(result: string): boolean {
  return result.startsWith(TERMINAL_UNAVAILABLE_PREFIX);
}

/** 開発サーバー系コマンドかどうか（終了しないため exec ではなくサーバー起動へ回す）。
    複合コマンド（&& や ; 等）は対象外とし、通常の exec に任せる */
export function isDevServerCommand(command: string): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (!c || /[|&;<>`$()]/.test(c)) return false;
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)(\s|$)/.test(c)) return true;
  if (/^(npx\s+)?vite(\s+dev)?(\s|$)/.test(c)) return true;
  if (/^npx\s+(next|nuxt|astro|remix)\s+dev(\s|$)/.test(c)) return true;
  return false;
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
  /** WebContainer.boot() を実際に呼んだか（boot はページ内で1回しか呼べない） */
  private bootCalled = false;
  /** このページセッションでは回復不能と判断した起動失敗（再試行で boot を二重に呼ばないため固定する） */
  private bootError = "";
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

  /** 起動本体。boot() はページ内で1回しか呼べないため、この promise は作り直さない */
  private async doBoot(): Promise<WebContainer> {
    if (typeof window === "undefined" || !window.crossOriginIsolated) {
      throw new Error(
        "このページが crossOriginIsolated になっていないため、WebContainer を起動できません（サーバーの COOP/COEP ヘッダーが必要です）。",
      );
    }
    const { WebContainer } = await withTimeout(
      import("@webcontainer/api"),
      WC_TIMEOUTS.importMs,
      "WebContainerライブラリの読み込み",
    );
    this.bootCalled = true;
    const wc = await WebContainer.boot();
    wc.on("server-ready", (_port, url) => {
      this.previewUrl = url;
      this.previewListeners.forEach((fn) => fn(url));
    });
    wc.on("error", (err) => {
      this.setState("error", `WebContainer エラー: ${err.message}`);
    });
    this.wc = wc;
    /* タイムアウトで「失敗」として扱った後に裏で起動が完了したら、使える状態へ戻す */
    if (this.state === "error" && this.bootError) this.bootError = "";
    this.setState("ready");
    return wc;
  }

  /** 起動する（未起動なら boot、失敗なら理由を保持して例外）。
      タイムアウトしても boot 本体は裏で続いている可能性があるため、bootPromise は保持し続け、
      boot を二重に呼ばない。タイムアウト／boot 後の失敗はこのセッションでは回復不能として固定し、
      呼び出し直後に失敗を返す（毎回60秒待たせない）。読み込み段階の失敗だけは再試行できる */
  async ensureBoot(): Promise<WebContainer> {
    if (this.wc) return this.wc;
    if (this.bootError) throw new Error(this.bootError);
    if (!this.bootPromise) {
      this.setState("booting");
      this.bootPromise = this.doBoot();
      /* レース負け後に doBoot が遅れて失敗しても未処理 rejection にしない */
      this.bootPromise.catch(() => undefined);
    }
    try {
      return await withTimeout(this.bootPromise, WC_TIMEOUTS.bootMs, "WebContainerの起動");
    } catch (e) {
      const timedOut = e instanceof PhaseTimeoutError;
      const base = e instanceof Error ? e.message : String(e);
      const msg = timedOut
        ? `${base}起動が応答しないため、このページを開いている間はターミナルを利用できません。ページを再読み込みすると再試行できます。`
        : base;
      this.setState("error", msg);
      if (timedOut || this.bootCalled) {
        this.bootError = msg;
      } else {
        /* ライブラリ読み込み等の boot 前の失敗は、次回の呼び出しで再試行できる */
        this.bootPromise = null;
      }
      throw new Error(msg);
    }
  }

  /** プロジェクト全体をコンテナへマウントする（応答しない場合は段階名つきでタイムアウトさせる） */
  async mountProject(files: Record<string, string>): Promise<void> {
    const wc = await this.ensureBoot();
    await withTimeout(wc.mount(toFileSystemTree(files)), WC_TIMEOUTS.mountMs, "プロジェクトの読み込み（マウント）");
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

  /** spawn に上限時間を付ける（spawn 自体が応答しない環境で固まらないため） */
  private async spawnBounded(wc: WebContainer, command: string): Promise<WebContainerProcess> {
    const trimmed = command.trim();
    let sp: Promise<WebContainerProcess>;
    if (SHELL_META.test(trimmed)) {
      sp = wc.spawn("jsh", ["-c", trimmed]);
    } else {
      const parsed = splitCommand(trimmed);
      if (!parsed) throw new Error("コマンドが空です");
      sp = wc.spawn(parsed.cmd, parsed.args);
    }
    return withTimeout(sp, WC_TIMEOUTS.spawnMs, "コマンドの開始");
  }

  /** コマンドを実行する。シェル記法が含まれる場合は jsh -c、なければ直接 spawn */
  async exec(command: string, opts: { timeoutMs?: number; onOutput?: OutputListener } = {}): Promise<ExecResult> {
    const wc = await this.ensureBoot();
    const trimmed = command.trim();
    if (!trimmed) return { code: 0, output: "" };
    const proc = await this.spawnBounded(wc, trimmed);
    this.current = proc;
    try {
      return await this.collect(proc, opts.onOutput, opts.timeoutMs ?? WC_TIMEOUTS.execMs);
    } finally {
      if (this.current === proc) this.current = null;
    }
  }

  /** 開発サーバーを起動する。終了は待たず、URL発行か終了か上限時間までだけ待って結果を返す。
      上限を過ぎてもプロセスは殺さない（裏で起動を続け、URLは発行され次第プレビューに届く） */
  async startDevServer(onOutput: OutputListener, command = "npm run dev"): Promise<DevServerStartResult> {
    const wc = await this.ensureBoot();
    await this.stopDevServer();
    this.previewUrl = "";
    const proc = await this.spawnBounded(wc, command.trim() || "npm run dev");
    this.devServer = proc;
    let log = "";
    const collect = (chunk: string) => {
      const clean = stripAnsi(chunk);
      log = (log + clean).slice(-8_000);
      onOutput(clean);
    };
    void (async () => {
      const reader = proc.output.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        collect(value);
      }
    })().catch(() => undefined);
    void proc.exit.then((code) => {
      onOutput(`\n[開発サーバーが終了しました（code ${code}）]\n`);
      if (this.devServer === proc) this.devServer = null;
    });
    const outcome = await new Promise<{ url: string; exitCode: number | null }>((resolve) => {
      let done = false;
      let offPreview: () => void = () => undefined;
      const finish = (v: { url: string; exitCode: number | null }) => {
        if (done) return;
        done = true;
        offPreview();
        resolve(v);
      };
      offPreview = this.onPreview((url) => finish({ url, exitCode: null }));
      if (this.previewUrl) {
        finish({ url: this.previewUrl, exitCode: null });
        return;
      }
      void proc.exit.then((code) => finish({ url: "", exitCode: code }));
      setTimeout(() => finish({ url: this.previewUrl, exitCode: null }), WC_TIMEOUTS.serverReadyMs);
    });
    return { url: outcome.url, log, ready: !!outcome.url, exitCode: outcome.exitCode };
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
