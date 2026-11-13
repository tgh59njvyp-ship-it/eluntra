import { useEffect, useMemo, useState } from "react";
import { update, useStore } from "../lib/store";
import { Icon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** ヘッダーの検索アイコン用：会話タイトルと本文から探す簡易検索シート */
export function SearchSheet({ open, onClose }: Props) {
  const sessions = useStore((s) => s.sessions);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open ]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q)),
    );
  }, [sessions, query]);

  const jump = (id: string) => {
    update({ currentId: id });
    onClose();
  };

  return (
    <>
      <div className={`sheet-back${open ? " on" : ""}`} onClick={onClose} />
      <section className={`sheet${open ? " on" : ""}`} aria-hidden={!open} aria-label="会話を検索">
        <div className="sheet-head">
          <h2>会話を検索</h2>
          <button type="button" className="iconbtn" aria-label="閉じる" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">
          <input
            className="search-input"
            placeholder="タイトルや本文のキーワード"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="検索キーワード"
          />
          <div style={{ marginTop: 10 }}>
            {list.length === 0 && (
              <div style={{ padding: "8px 4px", color: "var(--text-3)", fontSize: 13.5 }}>見つかりませんでした</div>
            )}
            {list.map((s) => (
              <button key={s.id} type="button" className="session-item" onClick={() => jump(s.id)}>
                <span className="t">{s.title || "新しいチャット"}</span>
              </button>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
