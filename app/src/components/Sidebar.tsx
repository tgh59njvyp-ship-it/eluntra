import { useMemo, useState } from "react";
import { isLoggedIn, currentUser } from "../lib/auth";
import { getState, sessionKindOf, update, useStore } from "../lib/store";
import { Icon } from "./icons";
import { Logo } from "./Logo";

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
  const mode = useStore((s) => s.conf.mode);
  const user = currentUser();
  const [query, setQuery] = useState("");

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (sessionKindOf(s) !== mode) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.messages.some((m) => m.content.toLowerCase().includes(q))
      );
    });
  }, [sessions, mode, query]);

  const setMode = (m: "chat" | "code") => {
    const st = getState();
    update({ conf: { ...st.conf, mode: m } });
    const same = getState().sessions.find((x) => sessionKindOf(x) === m);
    update({ currentId: same ? same.id : null });
  };

  return (
    <>
      <div className={`drawer-back${open ? " on" : ""}`} onClick={onClose} />
      <aside className={`sidebar${open ? " open" : ""}`}>
        <div className="side-head">
          <Logo size={32} />
          <span className="logo">Eluntra</span>
          <span className="pill-state">v7.2.2</span>
        </div>
        <div className="logo-sub">30社のAIを、自分のキーで使うチャット</div>
        <div style={{ display: "flex", gap: 6, padding: "0 12px 10px" }}>
          <button type="button" className={`tool-toggle${mode === "chat" ? " on" : ""}`} onClick={() => setMode("chat")}>
            チャット
          </button>
          <button type="button" className={`tool-toggle${mode === "code" ? " on" : ""}`} onClick={() => setMode("code")}>
            <Icon name="code" className="ic sm" /> コード
          </button>
        </div>
        <div className="side-actions">
          <button type="button" className="btn primary sm" style={{ flex: 1 }} onClick={onNew}>
            <Icon name="plus" className="ic sm" /> 新しい{mode === "code" ? "コード" : "チャット"}
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
          <div className="side-sec">{mode === "code" ? "コード履歴" : "チャット履歴"}</div>
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
            href="developer.html"
            target="_blank"
            rel="noreferrer"
            style={{ textDecoration: "none" }}
          >
            <Icon name="codeB" className="ic sm" />
            <span className="t">Developer（AI開発環境）</span>
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
