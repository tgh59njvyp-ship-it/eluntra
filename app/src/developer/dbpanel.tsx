/* Eluntra Developer: データベースパネル
   SQLite（sql.js）と PostgreSQL（PGlite）をブラウザ内で実際に動かす。
   データは端末の IndexedDB に保存され、サーバーは使わない。 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/icons";
import type { ShellProps } from "./DeveloperApp";
import { DIcon } from "./panels";
import {
  dbService, type DbEngine, type DbMeta, type DbTableInfo, type QueryOutcome,
} from "./db";

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Uint8Array) return `BLOB (${v.length} bytes)`;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function DbPane(p: ShellProps) {
  const projectId = p.project?.id || "";
  const [metas, setMetas] = useState<DbMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [newName, setNewName] = useState("");
  const [newEngine, setNewEngine] = useState<DbEngine>("sqlite");
  const [sql, setSql] = useState("SELECT * FROM demo_items;");
  const [outcome, setOutcome] = useState<QueryOutcome | null>(null);
  const [schema, setSchema] = useState<DbTableInfo[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = metas.find((m) => m.id === selectedId) || null;

  const refreshSchema = useCallback(async (meta: DbMeta | null) => {
    if (!meta) {
      setSchema([]);
      return;
    }
    try {
      setSchema(await dbService.schema(meta));
    } catch {
      setSchema([]);
    }
  }, []);

  const reload = useCallback(async () => {
    if (!projectId) {
      setMetas([]);
      return;
    }
    const list = await dbService.listDbs(projectId);
    setMetas(list);
    setSelectedId((cur) => (list.some((m) => m.id === cur) ? cur : list[0]?.id || ""));
  }, [projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void refreshSchema(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, metas]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError("");
    setInfo("");
    try {
      const msg = await fn();
      setInfo(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy("");
  };

  const create = () =>
    run("create", async () => {
      const meta = await dbService.createDb(projectId, newName, newEngine);
      setNewName("");
      await reload();
      setSelectedId(meta.id);
      return `データベース「${meta.name}」（${meta.engine === "sqlite" ? "SQLite" : "PostgreSQL"}）を作成しました。`;
    });

  const remove = () =>
    run("delete", async () => {
      if (!selected) throw new Error("データベースが選択されていません");
      const name = selected.name;
      await dbService.deleteDb(selected);
      setOutcome(null);
      await reload();
      return `データベース「${name}」を削除しました。`;
    });

  const exec = () =>
    run("exec", async () => {
      if (!selected) throw new Error("データベースが選択されていません");
      const out = await dbService.execSql(selected, sql);
      setOutcome(out);
      await refreshSchema(selected);
      return out.message;
    });

  const seed = () =>
    run("seed", async () => {
      if (!selected) throw new Error("データベースが選択されていません");
      const out = await dbService.seed(selected);
      setOutcome(out);
      setSql("SELECT * FROM demo_items ORDER BY id;");
      await refreshSchema(selected);
      return "サンプルテーブル demo_items を作成しました。";
    });

  const exportDb = () =>
    run("export", async () => {
      if (!selected) throw new Error("データベースが選択されていません");
      const bytes = await dbService.exportSqliteBytes(selected);
      const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${selected.name}.db`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return `${selected.name}.db を書き出しました（${bytes.length} bytes）。`;
    });

  const importDb = async (file: File) => {
    await run("import", async () => {
      if (!selected) throw new Error("データベースが選択されていません");
      const bytes = new Uint8Array(await file.arrayBuffer());
      await dbService.importSqliteBytes(selected, bytes);
      setOutcome(null);
      await refreshSchema(selected);
      return `${file.name} を読み込みました（内容は置き換わりました）。`;
    });
  };

  if (!p.project) {
    return (
      <div className="dev-pane db">
        <div className="dev-empty-note" style={{ padding: 12 }}>
          プロジェクトを選択すると、そのプロジェクト用のデータベースを作れます。
        </div>
      </div>
    );
  }

  return (
    <div className="dev-pane db">
      <div className="dev-pane-head">
        <span>
          <DIcon name="db" className="dev-ic sm" /> データベース（ブラウザ内SQLite / PostgreSQL）
        </span>
        <span className="dev-pane-state">データはこの端末の IndexedDB に保存されます</span>
        <span className="dev-pane-btns">
          <button type="button" className="btn sm dev-pane-close" onClick={() => p.setBottomTab(null)}>
            閉じる
          </button>
        </span>
      </div>

      <div className="dev-db-body">
        <div className="dev-db-create">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新しいDB名（英数字）"
            aria-label="新しいデータベース名"
          />
          <select value={newEngine} onChange={(e) => setNewEngine(e.target.value as DbEngine)} aria-label="エンジン">
            <option value="sqlite">SQLite</option>
            <option value="postgres">PostgreSQL</option>
          </select>
          <button type="button" className="btn primary sm" disabled={!!busy || !newName.trim()} onClick={() => void create()}>
            {busy === "create" ? "作成中…" : "作成"}
          </button>
          {metas.length > 0 && (
            <>
              <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} aria-label="データベース選択">
                {metas.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}（{m.engine === "sqlite" ? "SQLite" : "PostgreSQL"}）
                  </option>
                ))}
              </select>
              <button type="button" className="btn danger sm" disabled={!!busy || !selected} onClick={() => void remove()}>
                削除
              </button>
              <button type="button" className="btn sm" disabled={!!busy || !selected} onClick={() => void seed()}>
                {busy === "seed" ? "作成中…" : "サンプルを作成"}
              </button>
              {selected?.engine === "sqlite" && (
                <>
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => void exportDb()}>
                    .dbを書き出し
                  </button>
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                    .dbを読み込み
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".db,.sqlite,.sqlite3"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void importDb(f);
                      e.target.value = "";
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>

        {error && <div className="dev-db-error">{error}</div>}
        {info && <div className="dev-db-info">{info}</div>}
        {metas.length === 0 && (
          <div className="dev-empty-note">
            まだデータベースがありません。名前を入れて「作成」すると、このプロジェクト用に SQLite / PostgreSQL がこの場で作られます（どちらもブラウザ内のWASMで実際に動作します）。作成後は「サンプルを作成」で動作をすぐ確認できます。
          </div>
        )}

        {selected && (
          <div className="dev-db-main">
            <div className="dev-db-schema">
              <div className="dev-db-schema-title">
                <Icon name="doc" className="ic sm" /> テーブル（{selected.name}）
              </div>
              {schema.length === 0 && <div className="dev-db-notables">テーブルはまだありません</div>}
              {schema.map((t) => (
                <div key={t.name} className="dev-db-table">
                  <div className="dev-db-table-name">{t.name}</div>
                  {t.columns.map((c) => (
                    <div key={c.name} className="dev-db-col">
                      <span>{c.name}</span>
                      <span className="ty">{c.type}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            <div className="dev-db-console">
              <textarea
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                rows={4}
                aria-label="SQL"
                placeholder="SQLを入力（複数文も可）"
              />
              <div className="dev-db-console-btns">
                <button type="button" className="btn primary sm" disabled={!!busy || !sql.trim()} onClick={() => void exec()}>
                  {busy === "exec" ? "実行中…" : "SQLを実行"}
                </button>
                <span className="dev-db-msg">{outcome?.message || ""}</span>
              </div>
              {outcome?.results.map((set, i) => (
                <div key={i} className="dev-db-result">
                  <table>
                    <thead>
                      <tr>
                        {set.columns.map((c, j) => (
                          <th key={j}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {set.rows.slice(0, 200).map((row, ri) => (
                        <tr key={ri}>
                          {row.map((v, ci) => (
                            <td key={ci} className={v === null || v === undefined ? "null" : ""}>
                              {fmtVal(v)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="dev-db-rowcount">
                    {set.rows.length} 行{set.rows.length > 200 ? "（先頭200行まで表示）" : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="dev-db-footnote">
          ※ MySQL / MongoDB はブラウザ内で動かせるサーバーの実装がないため未対応です（生成したコードから外部サービスへ接続する形のみ可能で、ブラウザから直接TCP接続はできません）。Java / C / C++ / Go / Rust の実行も未対応です（編集は可能です）。
        </div>
      </div>
    </div>
  );
}
