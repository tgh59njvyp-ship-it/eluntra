import { useEffect, useRef, useState } from "react";
import { readPickedFiles } from "../lib/files";
import { getState, providerDefOf, update, useStore } from "../lib/store";
import type { Attachment, ChatMessage, ChatSession, Effort } from "../lib/types";
import { Icon, ProviderTile } from "./icons";
import { CodePreviewSheet } from "./CodePreviewSheet";
import { Markdown } from "./Markdown";

interface Props {
  session: ChatSession | null;
  generating: boolean;
  targetLabel: { providerId: string; ok: boolean };
  onSend: (text: string, attachments: Attachment[]) => void;
  onImageGenerate: (prompt: string) => void;
  onStop: () => void;
  onRegenerate: () => void;
  onEditUser: (index: number) => void;
  onOpenSettings: () => void;
  toast: (msg: string) => void;
  draft?: { text: string; attachments: Attachment[]; nonce: number } | null;
  placeholder?: string;
}

const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "super", label: "Super high" },
];

/** 処理中メッセージの経過秒数（実時計。pending の間だけ1秒ごとに進む） */
function useElapsedSeconds(active: boolean): number {
  const [sec, setSec] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active) {
      startRef.current = null;
      setSec(0);
      return;
    }
    if (startRef.current === null) startRef.current = Date.now();
    const id = window.setInterval(() => {
      if (startRef.current !== null) setSec(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return sec;
}

/** 処理中インジケーター：3点パルス＋現在の作業ラベル＋経過秒数（v7.2.7） */
function PendingStatus({ label, sec }: { label: string; sec: number }) {
  return (
    <div className="proc-status" role="status">
      <span className="proc-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>
        {label}… {sec}秒
      </span>
    </div>
  );
}

function MessageItem({
  m, isLast, onRegenerate, onEdit, toast, onPreview,
}: {
  m: ChatMessage;
  isLast: boolean;
  onRegenerate: () => void;
  onEdit: () => void;
  toast: (msg: string) => void;
  onPreview: (code: string, lang: string) => void;
}) {
  const elapsed = useElapsedSeconds(!!m.pending);
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
  return (
    <div className="msg">
      <div className="msg-head">
        <span>{m.model || "Eluntra"}</span>
      </div>
      {m.steps && m.steps.length > 0 && (
        <div className="msg-steps">
          {m.steps.map((st, i) => {
            const isLastStep = i === m.steps!.length - 1;
            const active = !!m.pending && isLastStep;
            const done = !!m.pending && !isLastStep;
            return (
              <div className={`step${active ? " active" : ""}${done ? " done" : ""}`} key={i}>
                {active ? <span className="pulse-dot" aria-hidden="true" /> : <Icon name="check" className="ic sm" />}
                <span>{st}</span>
              </div>
            );
          })}
        </div>
      )}
      {(m.attachments || []).map((a, i) =>
        a.kind === "image" && a.dataUrl ? (
          <figure key={i} className="gen-img">
            <img className="attach-img big" src={a.dataUrl} alt={a.name || "生成画像"} />
            <a className="gen-dl" href={a.dataUrl} download={a.name || "eluntra-image.png"}>
              <Icon name="download" className="ic sm" />ダウンロード
            </a>
          </figure>
        ) : (
          <span key={i} className="attach-chip"><Icon name="pin" className="ic sm" />{a.name}</span>
        ),
      )}
      {m.pending && !m.content ? (
        <PendingStatus
          label={
            m.steps && m.steps.length
              ? m.steps[m.steps.length - 1]
              : m.model === "画像生成"
                ? "画像を生成中"
                : "回答を作成中"
          }
          sec={elapsed}
        />
      ) : (
        <div
          className="msg-body"
          onClick={(e) => {
            const pv = (e.target as HTMLElement).closest("[data-preview]");
            if (pv) {
              const block = pv.closest(".codeblock");
              const code = block?.querySelector("code");
              if (code) onPreview(code.textContent || "", pv.getAttribute("data-lang") || "html");
              return;
            }
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
      {m.pending && !!m.content && <PendingStatus label="回答を作成中" sec={elapsed} />}
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
  session, generating, targetLabel, onSend, onImageGenerate, onStop, onRegenerate, onEditUser, onOpenSettings, toast, placeholder, draft,
}: Props) {
  const conf = useStore((s) => s.conf);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<Attachment[]>([]);
  const [preview, setPreview] = useState<{ code: string; lang: string } | null>(null);
  const [imageMode, setImageMode] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const analyzeAfterPick = useRef(false);

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
    if (generating) return;
    if (imageMode) {
      if (!text) return;
      onImageGenerate(text);
      setInput("");
      setImageMode(false);
      requestAnimationFrame(grow);
      return;
    }
    if (!text && !files.length) return;
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
    /* 「この画像を分析して」カード経由：画像が付いたら文面を入れてフォーカスする */
    if (analyzeAfterPick.current) {
      analyzeAfterPick.current = false;
      if (attachments.some((a) => a.kind === "image")) {
        setInput("この画像を分析して");
        requestAnimationFrame(() => taRef.current?.focus());
      }
    }
  };

  const provider = providerDefOf(targetLabel.providerId) ?? null;
  const moreActive = conf.agent || conf.effort !== "medium";
  const isEmpty = messages.length === 0;

  return (
    <>
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-col">
          {messages.map((m, i) => (
            <MessageItem
              key={i}
              m={m}
              isLast={i === messages.length - 1}
              onRegenerate={onRegenerate}
              onEdit={() => onEditUser(i)}
              toast={toast}
              onPreview={(code, lang) => setPreview({ code, lang })}
            />
          ))}
        </div>
      </div>

      <div className="composer-wrap">
        {isEmpty && (
          <div className="sugg-chips" role="group" aria-label="提案">
            <button type="button" className="sugg-chip" onClick={() => onSend("今日のおすすめを教えて", [])}>
              <Icon name="chat" className="ic sm" />今日のおすすめを教えて
            </button>
            <button
              type="button"
              className="sugg-chip"
              onClick={() => {
                setInput("このコードを解説して：");
                requestAnimationFrame(() => taRef.current?.focus());
              }}
            >
              <Icon name="codeB" className="ic sm" />このコードを解説して
            </button>
            <button
              type="button"
              className="sugg-chip"
              onClick={() => {
                analyzeAfterPick.current = true;
                fileRef.current?.click();
              }}
            >
              <Icon name="img" className="ic sm" />この画像を分析して
            </button>
            <button type="button" className="sugg-chip" onClick={() => onSend("勉強のコツを教えて", [])}>
              <Icon name="bulb" className="ic sm" />勉強のコツを教えて
            </button>
          </div>
        )}
        <div className="composer-inner">
          {!targetLabel.ok && provider && (
            <button type="button" className="keywarn" onClick={onOpenSettings}>
              <Icon name="alert" className="ic sm" />
              <span>
                {provider.name}のAPIキーが未設定です。タップして設定を開いてください。
              </span>
            </button>
          )}
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
            <button type="button" className="iconbtn clipbtn" aria-label="ファイルを添付" onClick={() => fileRef.current?.click()}>
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
              placeholder={imageMode ? "画像の説明を入力..." : placeholder || "メッセージを入力..."}
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
              disabled={!generating && (imageMode ? !input.trim() : !input.trim() && !files.length)}
              onClick={generating ? onStop : submit}
            >
              <Icon name={generating ? "stop" : "plane"} />
            </button>
          </div>
          <div className="pillrow">
            <button
              type="button"
              className={`act-pill${conf.webSearch ? " on" : ""}`}
              aria-pressed={!!conf.webSearch}
              onClick={() => update({ conf: { ...getState().conf, webSearch: !conf.webSearch } })}
            >
              <Icon name="globe" className="ic sm" />検索
            </button>
            <button type="button" className="act-pill" onClick={() => fileRef.current?.click()}>
              <Icon name="doc" className="ic sm" />ファイルを添付
            </button>
            <button
              type="button"
              className={`act-pill${imageMode ? " on" : ""}`}
              aria-pressed={imageMode}
              onClick={() => {
                setImageMode((v) => !v);
                requestAnimationFrame(() => taRef.current?.focus());
              }}
            >
              <Icon name="img" className="ic sm" />画像を生成
            </button>
            <button type="button" className="act-pill more" aria-label="その他の機能" onClick={() => setMoreOpen(true)}>
              <Icon name="dots" className="ic sm" />
              {moreActive && <span className="dot" aria-hidden="true" />}
            </button>
          </div>
          <div className="composer-note">
            AIの回答は誤ることがあります。重要な内容は出典や公式情報で確認してください。
          </div>
        </div>
      </div>

      <div className={`sheet-back${moreOpen ? " on" : ""}`} onClick={() => setMoreOpen(false)} />
      <section className={`sheet${moreOpen ? " on" : ""}`} aria-hidden={!moreOpen} aria-label="その他の機能">
        <div className="sheet-head">
          <h2>その他の機能</h2>
          <button type="button" className="iconbtn" aria-label="閉じる" onClick={() => setMoreOpen(false)}>
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">
          <div className="switch-row">
            <div className="grow">
              <div className="ttl">Agent Mode</div>
              <div className="dsc">Web検索・ページ取得・Supabaseなどのツールを使いながら回答します</div>
            </div>
            <button
              type="button"
              className={`tool-toggle${conf.agent ? " on" : ""}`}
              aria-pressed={conf.agent}
              onClick={() => update({ conf: { ...getState().conf, agent: !conf.agent } })}
            >
              {conf.agent ? "ON" : "OFF"}
            </button>
          </div>
          <div className="switch-row col">
            <div className="grow">
              <div className="ttl">思考レベル</div>
              <div className="dsc">モデルの思考量（予算）にそのまま反映されます</div>
            </div>
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
          </div>
          <div className="switch-row" style={{ borderBottom: "none" }}>
            <div className="grow">
              <div className="ttl">現在のモデル</div>
              <div className="dsc">{provider ? provider.name : "未選択"}</div>
            </div>
            {provider && <ProviderTile pid={provider.id} mono={provider.mono} color={provider.color} />}
          </div>
        </div>
      </section>

      <CodePreviewSheet target={preview} onClose={() => setPreview(null)} toast={toast} />
    </>
  );
}
