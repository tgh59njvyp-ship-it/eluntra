import { useEffect, useRef, useState } from "react";
import { readPickedFiles } from "../lib/files";
import { findProvider } from "../lib/providers/registry";
import { getState, update, useStore } from "../lib/store";
import type { Attachment, ChatMessage, ChatSession, Effort } from "../lib/types";
import { Icon, ProviderTile } from "./icons";
import { Markdown } from "./Markdown";

interface Props {
  session: ChatSession | null;
  generating: boolean;
  targetLabel: { providerId: string; ok: boolean };
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onEditUser: (index: number) => void;
  onOpenSettings: () => void;
  toast: (msg: string) => void;
  draft?: { text: string; attachments: Attachment[]; nonce: number } | null;
  placeholder?: string;
}

const SUGGESTIONS = ["今日の出来事を調べて要約して", "TypeScriptのジェネリクスを例つきで教えて", "3日分の献立を考えて", "短い物語を書いて"];

const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "super", label: "Super high" },
];

function MessageItem({
  m, isLast, onRegenerate, onEdit, toast,
}: {
  m: ChatMessage;
  isLast: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  toast: (msg: string) => void;
}) {
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("コピーしました");
    } catch {
      toast("コピーに失敗しました");
    }
  };
  if (m.role === "user") {
    return (
      <div className="msg user">
        <div>
          {(m.attachments || []).map((a, i) =>
            a.kind === "image" ? (
              <img key={i} className="attach-img" src={a.dataUrl} alt={a.name} />
            ) : (
              <span key={i} className="attach-chip"><Icon name="pin" className="ic sm" />{a.name}</span>
            ),
          )}
          <div className="bubble">{m.content}</div>
          <div className="msg-actions" style={{ justifyContent: "flex-end" }}>
            <button type="button" aria-label="編集" onClick={onEdit}><Icon name="pencil" className="ic sm" /></button>
            <button type="button" aria-label="コピー" onClick={() => void copy(m.content)}><Icon name="copy" className="ic sm" /></button>
          </div>
        </div>
      </div>
    );
  }
  const prov = m.model ? undefined : undefined;
  void prov;
  return (
    <div className="msg">
      <div className="msg-head">
        <span>{m.model || "Eluntra"}</span>
      </div>
      {m.steps && m.steps.length > 0 && (
        <div className="msg-steps">
          {m.steps.map((st, i) => (
            <div className="step" key={i}>
              <Icon name="check" className="ic sm" />
              <span>{st}</span>
            </div>
          ))}
        </div>
      )}
      {(m.attachments || []).map((a, i) => (
        <span key={i} className="attach-chip"><Icon name="pin" className="ic sm" />{a.name}</span>
      ))}
      {m.pending && !m.content ? (
        <div className="typing">考え中…</div>
      ) : (
        <div
          className="msg-body"
          onClick={(e) => {
            const btn = (e.target as HTMLElement).closest("[data-copy]");
            if (btn) {
              const pre = btn.closest(".codeblock")?.querySelector("code");
              if (pre) void copy(pre.textContent || "");
            }
          }}
        >
          <Markdown text={m.content} />
        </div>
      )}
      {m.metaNote && <div className="msg-note">{m.metaNote}</div>}
      {m.sources && m.sources.length > 0 && (
        <div className="msg-sources">
          <div style={{ color: "var(--text-3)", fontSize: 12 }}>出典</div>
          {m.sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noopener noreferrer">
              {i + 1}. {s.title}
            </a>
          ))}
        </div>
      )}
      {!m.pending && m.content && (
        <div className="msg-actions">
          <button type="button" aria-label="コピー" onClick={() => void copy(m.content)}><Icon name="copy" className="ic sm" /></button>
          {isLast && (
            <button type="button" aria-label="再生成" onClick={onRegenerate}><Icon name="refresh" className="ic sm" /></button>
          )}
        </div>
      )}
    </div>
  );
}

export function ChatPane({
  session, generating, targetLabel, onSend, onStop, onRegenerate, onEditUser, onOpenSettings, toast, placeholder, draft,
}: Props) {
  const conf = useStore((s) => s.conf);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);

  useEffect(() => {
    if (draft) {
      setInput(draft.text);
      setFiles(draft.attachments);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.nonce]);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const messages = session?.messages || [];
  const lastContentLen = messages.length ? messages[messages.length - 1].content.length : 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastContentLen, session?.id]);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  };

  const submit = () => {
    const text = input.trim();
    if ((!text && !files.length) || generating) return;
    onSend(text, files);
    setInput("");
    setFiles([]);
    requestAnimationFrame(grow);
  };

  const pickFiles = async (list: FileList | null) => {
    if (!list) return;
    const { attachments, warnings } = await readPickedFiles(list);
    warnings.forEach((w) => toast(w));
    setFiles((prev) => [...prev, ...attachments]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const provider = (() => {
    try {
      return findProvider(targetLabel.providerId);
    } catch {
      return null;
    }
  })();

  return (
    <>
      <div className="chat-scroll" ref={scrollRef}>
        <div className={`chat-col${conf.mode === "code" ? " wide" : ""}`}>
          {messages.length === 0 ? (
            <div className="empty">
              <h1>{conf.mode === "code" ? "作りたいものを、言葉で。" : "何でも聞いてください"}</h1>
              <p>
                {conf.mode === "code"
                  ? "完成コードを受け取って、その場でプレビューできます。"
                  : "30社のAIを、自分のAPIキーで使うチャットです。"}
              </p>
              <div className="steps-hint">
                <span>1 会社を選ぶ</span>
                <span>2 キーを設定する</span>
                <span>3 質問する</span>
              </div>
              <div className="chips">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => onSend(s, [])}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageItem
                key={i}
                m={m}
                isLast={i === messages.length - 1}
                onRegenerate={onRegenerate}
                onEdit={() => onEditUser(i)}
                toast={toast}
              />
            ))
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className={`composer-inner${conf.mode === "code" ? " wide" : ""}`}>
          {!targetLabel.ok && provider && (
            <button type="button" className="keywarn" onClick={onOpenSettings}>
              <Icon name="alert" className="ic sm" />
              <span>
                {provider.name}のAPIキーが未設定です。タップして設定を開いてください。
              </span>
            </button>
          )}
          <div className="composer-tools">
            <button
              type="button"
              className={`tool-toggle${conf.agent ? " on" : ""}`}
              onClick={() => update({ conf: { ...getState().conf, agent: !conf.agent } })}
              aria-pressed={conf.agent}
            >
              <Icon name="bot" className="ic sm" /> Agent Mode
            </button>
            <span className="effort-group" role="group" aria-label="思考レベル">
              {EFFORTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={conf.effort === e.id ? "on" : ""}
                  onClick={() => update({ conf: { ...getState().conf, effort: e.id } })}
                >
                  {e.label}
                </button>
              ))}
            </span>
            {provider && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--text-3)" }}>
                <ProviderTile mono={provider.mono} color={provider.color} />
                {provider.name}
              </span>
            )}
          </div>
          {files.length > 0 && (
            <div className="pending-files">
              {files.map((f, i) => (
                <span key={i} className="attach-chip">
                  <Icon name="pin" className="ic sm" />
                  {f.name}
                  <button
                    type="button"
                    aria-label="添付を外す"
                    style={{ border: "none", background: "transparent", display: "inline-flex", padding: 0 }}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" className="ic sm" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="box">
            <button type="button" className="iconbtn" aria-label="ファイルを添付" onClick={() => fileRef.current?.click()}>
              <Icon name="pin" />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={(e) => void pickFiles(e.target.files)}
            />
            <textarea
              ref={taRef}
              value={input}
              rows={1}
              placeholder={placeholder || "メッセージを入力"}
              onChange={(e) => {
                setInput(e.target.value);
                grow();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                }
              }}
              aria-label="メッセージ"
            />
            <button
              type="button"
              className={`sendbtn${generating ? " stop" : ""}`}
              aria-label={generating ? "停止" : "送信"}
              disabled={!generating && !input.trim() && !files.length}
              onClick={generating ? onStop : submit}
            >
              <Icon name={generating ? "stop" : "send"} />
            </button>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", textAlign: "center", paddingTop: 6 }}>
            AIの回答は誤ることがあります。重要な内容は出典や公式情報で確認してください。
          </div>
        </div>
      </div>
    </>
  );
}
