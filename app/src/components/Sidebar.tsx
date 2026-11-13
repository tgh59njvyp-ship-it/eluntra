import { useMemo, useState } from "react";
import { isLoggedIn, currentUser } from "../lib/auth";
import { getState, update, useStore } from "../lib/store";
import { Icon } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onOpenSettings: () => void;
  onSelect: (id: string) => void;
}

export function Sidebar({ open, onClose, onNew, onOpenSettings, onSelect }: Props) {
  const sessions = useStore((s) => s.sessions);
  const currentId = useStore((s) => s.currentId);
  const user = currentUser();
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q))
      );
    });
  }, [sessions, query]);

  return (
    <>
      <div className={`drawer-back${open ? " on" : ""}`} onClick={onClose} />
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="side-head">
          <span className="logo">Eluntra</span>
          <span className="pill-state">v8.0.0</span>
        </div>
        <div className="logo-sub">30社のAIを、自分のキーで使うチャット</div>
        <div className="side-actions">
          <button type="button" className="btn primary sm" style={{ flex: 1 }} onClick={onNew}>
            <Icon name="plus" className="ic sm" /> 新しいチャット
          </button>
        </div>
        <div className="side-search">
          <input
            className="search-input"
            placeholder="会話を検索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="会話を検索"
          />
        </div>
        <div className="side-list">
          <div className="side-sec">チャット履歴</div>
          {list.length === 0 && <div style={{ padding: "6px 8px", color: "var(--text-3)", fontSize: 13 }}>まだありません</div>}
          {list.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`session-item${s.id === currentId ? " on" : ""}`}
              onClick={() => {
                onSelect(s.id);
                onClose();
              }}
            >
              <span className="t">{s.title || "新しいチャット"}</span>
              <span
                className="del"
                role="button"
                aria-label="削除"
                onClick={(e) => {
                  e.stopPropagation();
                  const st = getState();
                  const next = st.sessions.filter((x) => x.id !== s.id);
                  update({
                    sessions: next,
                    currentId: st.currentId === s.id ? null : st.currentId,
                  });
                }}
              >
                <Icon name="trash" className="ic sm" />
              </span>
            </button>
          ))}
        </div>
        <div className="side-foot">
          <a
            className="session-item"
            href="playgrounds.html"
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: "none" }}
          >
            <Icon name="codeB" className="ic sm" />
            <span className="t">Playgrounds（AIコード生成）</span>
          </a>
          <button
            type="button"
            className="session-item"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
          >
            <Icon name="gear" className="ic sm" />
            <span className="t">設定{user ? `（${user.name || user.email || "ログイン中"}）` : ""}</span>
          </button>
          {!isLoggedIn() && <div style={{ fontSize: 12, color: "var(--text-3)", padding: "4px 8px 0" }}>未ログイン（端末内のみ保存）</div>}
        </div>
      </aside>
    </>
  );
}
