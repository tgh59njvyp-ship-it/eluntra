/* Playgrounds: ターミナル連携バス
   エディタの「実行」ボタンなど、ターミナルペイン外から
   「ファイルを実行して出力をターミナルへ出す」ための小さな連携層。 */

type AppendFn = (chunk: string) => void;
type RunFileFn = (path: string) => void;

class TermBus {
  private appendFns = new Set<AppendFn>();
  private runFileHandler: RunFileFn | null = null;
  private pendingRunFile: string | null = null;

  onAppend(fn: AppendFn): () => void {
    this.appendFns.add(fn);
    return () => this.appendFns.delete(fn);
  }

  append(chunk: string): void {
    this.appendFns.forEach((fn) => fn(chunk));
  }

  onRunFile(fn: RunFileFn): () => void {
    this.runFileHandler = fn;
    if (this.pendingRunFile) {
      const path = this.pendingRunFile;
      this.pendingRunFile = null;
      fn(path);
    }
    return () => {
      if (this.runFileHandler === fn) this.runFileHandler = null;
    };
  }

  requestRunFile(path: string): void {
    if (this.runFileHandler) this.runFileHandler(path);
    else this.pendingRunFile = path;
  }

  get hasRunFileHandler(): boolean {
    return !!this.runFileHandler;
  }
}

export const termBus = new TermBus();
