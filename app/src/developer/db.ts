/* Eluntra Developer: ブラウザ内データベース（SQLite / PostgreSQL）
   - SQLite: sql.js（SQLite の WASM 版）。データは IndexedDB にバイト列で永続化する。
   - PostgreSQL: PGlite（PostgreSQL の WASM 版）。データは PGlite 自身が IndexedDB に永続化する（idb://）。
   どちらも自サイト配信のアセットだけで動作し、サーバーは使わない。
   データベースはテキストのプロジェクトFSとは別管理（projectId + 名前で対応付け）。 */

export type DbEngine = "sqlite" | "postgres";

export interface DbMeta {
  id: string;
  projectId: string;
  name: string;
  engine: DbEngine;
  createdAt: number;
}

export interface QueryResultSet {
  columns: string[];
  rows: Array<Array<unknown>>;
}

export interface QueryOutcome {
  results: QueryResultSet[];
  message: string;
}

export interface DbTableInfo {
  name: string;
  columns: Array<{ name: string; type: string }>;
}

const IDB_NAME = "eluntra-dev-dbs";
const AGENT_MAX_ROWS = 100;
const AGENT_MAX_CHARS = 8000;

/* ---------- SQL の読み書き判定（純粋関数） ---------- */

const READ_KEYWORDS = new Set(["select", "explain", "values", "table", "show", "describe", "pragma"]);

/** 先頭キーワードで読み取り専用かを判定する（エージェントのモード制限に使う簡易判定）。
    WITH は本体に SELECT を含む場合のみ読み取り扱い。PRAGMA は代入形（=）なら書き込み扱い。 */
export function isReadOnlySql(sql: string): boolean {
  const cleaned = (sql || "")
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
  if (!cleaned) return true;
  const first = (cleaned.match(/^[A-Za-z]+/)?.[0] || "").toLowerCase();
  if (first === "with") {
    if (/\b(insert|update|delete|merge)\b/i.test(cleaned)) return false;
    return /\bselect\b/i.test(cleaned);
  }
  if (first === "pragma") return !cleaned.includes("=");
  return READ_KEYWORDS.has(first);
}

/* ---------- IndexedDB 最小ラッパー ---------- */

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) {
        const st = db.createObjectStore("meta", { keyPath: "id" });
        st.createIndex("projectId", "projectId", { unique: false });
      }
      if (!db.objectStoreNames.contains("sqlite-bytes")) db.createObjectStore("sqlite-bytes");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (db: IDBDatabase) => IDBRequest<T>): Promise<T> {
  const db = await idbOpen();
  try {
    void mode;
    return await reqToPromise(fn(db));
  } finally {
    db.close();
  }
}

async function idbGetMetaAll(projectId: string): Promise<DbMeta[]> {
  const db = await idbOpen();
  try {
    const tx = db.transaction("meta", "readonly");
    const idx = tx.objectStore("meta").index("projectId");
    return await new Promise<DbMeta[]>((resolve, reject) => {
      const req = idx.getAll(projectId);
      req.onsuccess = () => resolve((req.result as DbMeta[]).sort((a, b) => a.createdAt - b.createdAt));
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/* ---------- ランタイム設定（テストから差し替え可能） ---------- */

export interface DbRuntimeConfig {
  /** sql.js の wasm 場所を返す */
  sqlLocateFile: (file: string) => string;
  /** PGlite の dataDir 接頭辞。ブラウザでは idb://、テストでは未指定（メモリ）も可 */
  pgDataDir: (meta: DbMeta) => string | undefined;
}

let runtimeConfig: DbRuntimeConfig = {
  sqlLocateFile: (file) =>
    typeof document !== "undefined" ? new URL(`sqlite/${file}`, document.baseURI).toString() : file,
  pgDataDir: (meta) => `idb://eluntra-pg-${meta.id}`,
};

export function setDbRuntimeConfig(cfg: Partial<DbRuntimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...cfg };
}

/* ---------- エンジン実体 ---------- */

interface SqliteDb {
  kind: "sqlite";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}
interface PgDb {
  kind: "postgres";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pg: any;
}
type OpenDb = SqliteDb | PgDb;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqlJsPromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadSqlJs(): Promise<any> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const initSqlJs = (await import("sql.js")).default;
      return initSqlJs({ locateFile: (f: string) => runtimeConfig.sqlLocateFile(f) });
    })();
  }
  return sqlJsPromise;
}

const SEED_SQL: Record<DbEngine, string> = {
  sqlite: [
    "CREATE TABLE IF NOT EXISTS demo_items (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);",
    "DELETE FROM demo_items;",
    "INSERT INTO demo_items (name, price) VALUES ('りんご', 150), ('みかん', 80), ('ぶどう', 300);",
  ].join("\n"),
  postgres: [
    "CREATE TABLE IF NOT EXISTS demo_items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL);",
    "DELETE FROM demo_items;",
    "INSERT INTO demo_items (name, price) VALUES ('りんご', 150), ('みかん', 80), ('ぶどう', 300);",
  ].join("\n"),
};

class DbService {
  private openCache = new Map<string, OpenDb>();
  private metaCache = new Map<string, DbMeta[]>();

  async listDbs(projectId: string): Promise<DbMeta[]> {
    const metas = await idbGetMetaAll(projectId);
    this.metaCache.set(projectId, metas);
    return metas;
  }

  /** 同期的に参照できるキャッシュ（エージェントのコンテキスト用） */
  cachedList(projectId: string): DbMeta[] {
    return this.metaCache.get(projectId) || [];
  }

  async createDb(projectId: string, name: string, engine: DbEngine): Promise<DbMeta> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("データベース名を入力してください");
    if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) throw new Error("データベース名は英数字・ハイフン・アンダースコアのみ使えます");
    const existing = await this.listDbs(projectId);
    if (existing.some((d) => d.name === trimmed)) throw new Error(`同名のデータベースがあります: ${trimmed}`);
    const meta: DbMeta = {
      id: `db-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      projectId,
      name: trimmed,
      engine,
      createdAt: Date.now(),
    };
    await idb("readwrite", (db) => db.transaction("meta", "readwrite").objectStore("meta").put(meta));
    // 実体の初期化（失敗したらメタも戻す）
    try {
      const open = await this.openDb(meta);
      if (open.kind === "postgres") await open.pg.query("SELECT 1");
    } catch (e) {
      await idb("readwrite", (db) => db.transaction("meta", "readwrite").objectStore("meta").delete(meta.id));
      throw e;
    }
    this.metaCache.set(projectId, [...existing, meta]);
    return meta;
  }

  async deleteDb(meta: DbMeta): Promise<void> {
    const open = this.openCache.get(meta.id);
    if (open) {
      try {
        if (open.kind === "postgres") await open.pg.close();
        else open.db.close();
      } catch {
        /* ignore */
      }
      this.openCache.delete(meta.id);
    }
    await idb("readwrite", (db) => db.transaction("meta", "readwrite").objectStore("meta").delete(meta.id));
    await idb("readwrite", (db) => db.transaction("sqlite-bytes", "readwrite").objectStore("sqlite-bytes").delete(meta.id));
    if (meta.engine === "postgres") {
      // PGlite の idb ストレージをベストエフォートで消す（名前に対象IDを含むDBを削除）
      try {
        const dbs = (await indexedDB.databases?.()) || [];
        for (const info of dbs) {
          if (info.name && info.name.includes(meta.id)) {
            await new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(info.name!);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            });
          }
        }
      } catch {
        /* 削除できなくてもメタは消えている */
      }
    }
    const list = this.metaCache.get(meta.projectId);
    if (list) this.metaCache.set(meta.projectId, list.filter((d) => d.id !== meta.id));
  }

  async openDb(meta: DbMeta): Promise<OpenDb> {
    const cached = this.openCache.get(meta.id);
    if (cached) return cached;
    if (meta.engine === "sqlite") {
      const SQL = await loadSqlJs();
      const bytes = await idb<Uint8Array | undefined>("readonly", (db) =>
        db.transaction("sqlite-bytes", "readonly").objectStore("sqlite-bytes").get(meta.id),
      );
      const db = bytes && bytes.length ? new SQL.Database(bytes) : new SQL.Database();
      const open: OpenDb = { kind: "sqlite", db };
      this.openCache.set(meta.id, open);
      return open;
    }
    const { PGlite } = await import("@electric-sql/pglite");
    const dataDir = runtimeConfig.pgDataDir(meta);
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    const open: OpenDb = { kind: "postgres", pg };
    this.openCache.set(meta.id, open);
    return open;
  }

  private async persistSqlite(meta: DbMeta, open: SqliteDb): Promise<void> {
    const bytes: Uint8Array = open.db.export();
    await idb("readwrite", (db) => db.transaction("sqlite-bytes", "readwrite").objectStore("sqlite-bytes").put(bytes, meta.id));
  }

  /** SQLを実行する。複数文・結果セット・変更行数をまとめて返す */
  async execSql(meta: DbMeta, sql: string): Promise<QueryOutcome> {
    const text = (sql || "").trim();
    if (!text) throw new Error("SQLが空です");
    const open = await this.openDb(meta);
    if (open.kind === "sqlite") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: Array<{ columns: string[]; values: unknown[][] }> = open.db.exec(text);
      // getRowsModified は直前の書き込み文の値を保持するため、読み取り文では 0 として扱う
      const modified: number = isReadOnlySql(text) ? 0 : open.db.getRowsModified();
      const results: QueryResultSet[] = raw.map((r) => ({ columns: r.columns, rows: r.values }));
      if (!isReadOnlySql(text)) await this.persistSqlite(meta, open);
      return {
        results,
        message: results.length
          ? `${results.length}件の結果セット（変更行数: ${modified}）`
          : `実行しました（変更行数: ${modified}）`,
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw: Array<{ rows: Array<Record<string, unknown>>; fields: Array<{ name: string }>; affectedRows?: number }> =
      await open.pg.exec(text);
    const results: QueryResultSet[] = [];
    let affected = 0;
    for (const r of raw) {
      affected += r.affectedRows ?? 0;
      if (r.fields && r.fields.length) {
        const columns = r.fields.map((f) => f.name);
        results.push({ columns, rows: r.rows.map((row) => columns.map((c) => row[c])) });
      }
    }
    return {
      results,
      message: results.length ? `${results.length}件の結果セット（変更行数: ${affected}）` : `実行しました（変更行数: ${affected}）`,
    };
  }

  /** スキーマ（テーブルと列）を取得する */
  async schema(meta: DbMeta): Promise<DbTableInfo[]> {
    if (meta.engine === "sqlite") {
      const tables = await this.execSql(meta, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const out: DbTableInfo[] = [];
      for (const row of tables.results[0]?.rows || []) {
        const tname = String(row[0]);
        const cols = await this.execSql(meta, `PRAGMA table_info(${JSON.stringify(tname)})`);
        out.push({
          name: tname,
          columns: (cols.results[0]?.rows || []).map((r) => ({ name: String(r[1]), type: String(r[2] || "") })),
        });
      }
      return out;
    }
    const tables = await this.execSql(
      meta,
      "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_name",
    );
    const out: DbTableInfo[] = [];
    for (const row of tables.results[0]?.rows || []) {
      const tname = String(row[0]);
      const cols = await this.execSql(
        meta,
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '${tname.replace(/'/g, "''")}' ORDER BY ordinal_position`,
      );
      out.push({
        name: tname,
        columns: (cols.results[0]?.rows || []).map((r) => ({ name: String(r[0]), type: String(r[1] || "") })),
      });
    }
    return out;
  }

  /** サンプルテーブルを作って中身を返す（初回体験用） */
  async seed(meta: DbMeta): Promise<QueryOutcome> {
    await this.execSql(meta, SEED_SQL[meta.engine]);
    return this.execSql(meta, "SELECT * FROM demo_items ORDER BY id");
  }

  /** SQLite の .db バイト列を取り出す（書き出し用） */
  async exportSqliteBytes(meta: DbMeta): Promise<Uint8Array> {
    if (meta.engine !== "sqlite") throw new Error("書き出しはSQLiteのみ対応しています");
    const open = await this.openDb(meta);
    if (open.kind !== "sqlite") throw new Error("SQLiteではありません");
    return open.db.export() as Uint8Array;
  }

  /** SQLite の .db バイト列を取り込む（現在の内容と置き換え） */
  async importSqliteBytes(meta: DbMeta, bytes: Uint8Array): Promise<void> {
    if (meta.engine !== "sqlite") throw new Error("読み込みはSQLiteのみ対応しています");
    const SQL = await loadSqlJs();
    const db = new SQL.Database(bytes);
    // 妥当性確認（開けること）
    db.exec("SELECT name FROM sqlite_master LIMIT 1");
    const prev = this.openCache.get(meta.id);
    if (prev && prev.kind === "sqlite") {
      try {
        prev.db.close();
      } catch {
        /* ignore */
      }
    }
    this.openCache.set(meta.id, { kind: "sqlite", db });
    await this.persistSqlite(meta, { kind: "sqlite", db });
  }
}

export const dbService = new DbService();

/* ---------- エージェント向け整形 ---------- */

export function formatOutcomeForAgent(outcome: QueryOutcome, dbName: string): string {
  const lines: string[] = [`データベース「${dbName}」の実行結果: ${outcome.message}`];
  for (const set of outcome.results) {
    lines.push(`列: ${set.columns.join(" | ")}`);
    const rows = set.rows.slice(0, AGENT_MAX_ROWS);
    for (const row of rows) {
      lines.push(row.map((v) => (v === null || v === undefined ? "NULL" : String(v))).join(" | "));
    }
    if (set.rows.length > AGENT_MAX_ROWS) lines.push(`…ほか ${set.rows.length - AGENT_MAX_ROWS} 行`);
  }
  const text = lines.join("\n");
  return text.length > AGENT_MAX_CHARS ? text.slice(0, AGENT_MAX_CHARS) + "\n…（省略）" : text;
}

export function formatSchemaForAgent(tables: DbTableInfo[]): string {
  if (!tables.length) return "テーブルはまだありません。";
  return tables
    .map((t) => `${t.name}(${t.columns.map((c) => `${c.name} ${c.type}`.trim()).join(", ")})`)
    .join("\n");
}
