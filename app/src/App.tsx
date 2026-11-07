import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPane } from "./components/ChatPane";
import { CodePreview } from "./components/CodeMode";
import { Icon, ProviderTile } from "./components/icons";
import { extractHtml } from "./components/Markdown";
import { ModelSheet } from "./components/ModelSheet";
import { Settings } from "./components/Settings";
import { Sidebar } from "./components/Sidebar";
import { Welcome } from "./components/Welcome";
import { clearAutoSkip, resolveAuto, skipAutoProviders } from "./lib/auto";
import { runAgent } from "./lib/agent/engine";
import { handleAuthCallback, isLoggedIn, onAuthChange, pullSync, pushSync } from "./lib/auth";
import { streamWithFallback } from "./lib/providers/chat";
import { findProvider } from "./lib/providers/registry";
import { UserError } from "./lib/providers/transport";
import {
  createSession, currentSession, ensureSession, getState, hasCredentials, pushRecent, runtime,
  selectedModel, update, useStore,
} from "./lib/store";
import type { Attachment, ChatMessage, ChatSession } from "./lib/types";

function patchSession(id: string, fn: (s: ChatSession) => ChatSession): void {
  const st = getState();
  update({ sessions: st.sessions.map((s) => (s.id === id ? fn(s) : s)) });
}

export default function App() {
  const conf = useStore((s) => s.conf);
  const sessions = useStore((s) => s.sessions);
  const currentId = useStore((s) => s.currentId);
  const theme = useStore((s) => s.theme);
  void sessions;
  const [, setAuthTick] = useState(0);
  const [entered, setEntered] = useState<boolean>(() => {
    try {
      return isLoggedIn() || localStorage.getItem("eluntra_guest") === "1";
    } catch {
      return false;
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sheet, setSheet] = useState<"none" | "model" | "settings">("none");
  const [toastMsg, setToastMsg] = useState("");
  const [generating, setGenerating] = useState(false);
  const [codeShow, setCodeShow] = useState(false);
  const toastTimer = useRef<number>(0);
  const session = currentSession();

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(""), 3600);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const off = onAuthChange(() => setAuthTick((t) => t + 1));
    void (async () => {
      const r = await handleAuthCallback();
      if (r.handled) {
        if (r.error) toast(r.error);
        else {
          setEntered(true);
          await pullSync();
          void pushSync();
        }
      } else if (isLoggedIn()) {
        await pullSync();
      }
    })();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (entered && !currentSession()) ensureSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered, conf.mode]);

  const target = useMemo(() => {
    if (conf.provider === "auto") {
      const any = ["gemini", "groq", "openai", "openrouter", "mistral", "deepseek", "anthropic", "cohere", "cerebras"].some(
        (id) => hasCredentials(id),
      );
      return { providerId: "gemini", ok: any || Object.keys(getState().keys).length > 0, label: "Eluntra Auto", model: "" };
    }
    return {
      providerId: conf.provider,
      ok: hasCredentials(conf.provider) || !!getState().tested[conf.provider],
      label: findProvider(conf.provider).name,
      model: selectedModel(conf.provider),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conf.provider, conf.models, sessions]);

  const stop = useCallback(() => {
    runtime.abortCtl?.abort();
  }, []);

  const send = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (runtime.generating) return;
      const s = ensureSession();
      const hasImage = attachments.some((a) => a.kind === "image");
      const userMsg: ChatMessage = { role: "user", content: text, attachments: attachments.length ? attachments : undefined };
      const aiMsg: ChatMessage = { role: "assistant", content: "", model: "", pending: true };
      patchSession(s.id, (x) => ({
        ...x,
        title: x.messages.length === 0 ? (text || "添付ファイル").slice(0, 28) : x.title,
        messages: [...x.messages, userMsg, aiMsg],
      }));
      const history = [...s.messages, userMsg];

      // 画像を送れない会社では事前に案内する
      const firstChoice = conf.provider === "auto" ? resolveAuto(text, { hasImage }) : null;
      const firstProvider = firstChoice?.provider ?? (conf.provider === "auto" ? null : findProvider(conf.provider));
      if (firstProvider && hasImage && !firstProvider.vision) {
        patchSession(s.id, (x) => ({
          ...x,
          messages: x.messages.map((m) =>
            m === x.messages[x.messages.length - 1]
              ? { ...m, pending: false, content: `（${firstProvider.name}の選択中モデルは画像送信に未対応のため、画像を送らずテキストだけで送信しました）` }
              : m,
          ),
        }));
      }

      const ctl = new AbortController();
      runtime.abortCtl = ctl;
      runtime.generating = true;
      setGenerating(true);

      const setAi = (fn: (m: ChatMessage) => ChatMessage) => {
        patchSession(s.id, (x) => {
          const msgs = [...x.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") msgs[msgs.length - 1] = fn(last);
          return { ...x, messages: msgs };
        });
      };

      let rafId = 0;
      let queued = "";
      const queueDelta = (full: string) => {
        queued = full;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          const v = queued;
          setAi((m) => ({ ...m, content: v }));
        });
      };

      try {
        let attempts = 0;
        let lastError: unknown = null;
        let done = false;
        while (attempts < 3 && !done) {
          attempts++;
          let provider = firstProvider;
          let model = "";
          let reason: string | undefined;
          if (conf.provider === "auto") {
            const choice = attempts === 1 && firstChoice ? firstChoice : resolveAuto(text, { hasImage });
            if (!choice) throw new UserError("接続済みのプロバイダーがありません。対処：設定でいずれかの会社のキーを保存し、「接続テスト」を押してください。");
            provider = choice.provider;
            model = choice.model;
            reason = choice.reason;
          } else if (provider) {
            model = selectedModel(provider.id);
          }
          if (!provider) throw new UserError("接続済みのプロバイダーがありません。対処：設定でキーを保存してください。");
          const key = (getState().keys[provider.id] || "").trim();
          if (!key && !provider.noKey) {
            setAi((m) => ({
              ...m,
              pending: false,
              model: provider!.name,
              content: `（${provider!.name}のキーが未設定のため送信できませんでした。設定からキーを追加してください）`,
            }));
            done = true;
            break;
          }
          setAi((m) => ({ ...m, model: `${provider!.name} / ${model}` }));
          try {
            if (getState().conf.agent) {
              const r = await runAgent(
                provider,
                model,
                history,
                (prog) => setAi((m) => ({ ...m, steps: prog.steps, sources: prog.sources })),
                ctl.signal,
              );
              setAi((m) => ({
                ...m,
                pending: false,
                content: r.text || "（回答が空でした）",
                sources: r.sources.length ? r.sources : m.sources,
                steps: r.steps,
                metaNote: reason,
              }));
            } else {
              const r = await streamWithFallback(provider, model, history, queueDelta, ctl.signal);
              if (rafId) cancelAnimationFrame(rafId);
              setAi((m) => ({
                ...m,
                pending: false,
                content: r.text,
                sources: r.sources && r.sources.length ? r.sources : m.sources,
                metaNote: reason,
              }));
            }
            pushRecent(provider.id, model);
            patchSession(s.id, (x) => ({ ...x, providerAtSend: provider!.id }));
            // コードモード：完成コードをプレビューへ反映
            if (getState().conf.mode === "code") {
              const st = getState();
              const sess = st.sessions.find((x) => x.id === s.id);
              const lastAi = sess?.messages[sess.messages.length - 1];
              if (lastAi) {
                const html = extractHtml(lastAi.content);
                if (html) update({ codes: { ...st.codes, [s.id]: html } });
              }
            }
            void pushSync();
            done = true;
          } catch (e) {
            if (e instanceof DOMException && e.name === "AbortError") {
              setAi((m) => ({ ...m, pending: false, content: m.content || "（停止しました）" }));
              done = true;
              break;
            }
            lastError = e;
            if (e instanceof UserError) {
              setAi((m) => ({ ...m, pending: false, content: e.message }));
              done = true;
              break;
            }
            if (conf.provider === "auto") {
              skipAutoProviders([provider.id]);
              setAi((m) => ({ ...m, content: "", steps: undefined }));
              continue;
            }
            break;
          }
        }
        if (!done) {
          void lastError;
          setAi((m) => ({
            ...m,
            pending: false,
            content: m.content || "いま応答が返ってきませんでした。少し時間をおいて、もう一度送ってください。",
          }));
        }
      } finally {
        if (rafId) cancelAnimationFrame(rafId);
        runtime.generating = false;
        runtime.abortCtl = null;
        setGenerating(false);
        clearAutoSkip();
      }
    },
    [conf.provider],
  );

  const regenerate = useCallback(() => {
    const s = currentSession();
    if (!s || runtime.generating) return;
    const msgs = [...s.messages];
    if (msgs.length && msgs[msgs.length - 1].role === "assistant") msgs.pop();
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    patchSession(s.id, (x) => ({ ...x, messages: msgs.slice(0, msgs.lastIndexOf(lastUser as ChatMessage)) }));
    if (lastUser) void send(lastUser.content, lastUser.attachments || []);
  }, [send ]);

  const [editDraft, setEditDraft] = useState<{ text: string; attachments: Attachment[]; nonce: number } | null>(null);
  const editUser = useCallback((index: number) => {
    const s = currentSession();
    if (!s || runtime.generating) return;
    const targetMsg = s.messages[index];
    if (!targetMsg || targetMsg.role !== "user") return;
    patchSession(s.id, (x) => ({ ...x, messages: x.messages.slice(0, index) }));
    setEditDraft({ text: targetMsg.content, attachments: targetMsg.attachments || [], nonce: Date.now() });
  }, []);

  if (!entered) {
    return (
      <div className="app" style={{ display: "block", overflowY: "auto" }}>
        <Welcome
          onGuest={() => {
            try {
              localStorage.setItem("eluntra_guest", "1");
            } catch {
              /* ignore */
            }
            setEntered(true);
          }}
        />
        {toastMsg && <div className="toast">{toastMsg}</div>}
      </div>
    );
  }

  const pillProvider = conf.provider === "auto" ? null : findProvider(conf.provider);

  return (
    <div className="app">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onNew={() => {
          update({ currentId: null });
          createSession();
        }}
        onOpenSettings={() => setSheet("settings")}
        onSelect={(id) => update({ currentId: id })}
      />
      <div className="main">
        <header className="topbar">
          <button type="button" className="iconbtn only-sp" aria-label="メニュー" onClick={() => setSidebarOpen(true)}>
            <Icon name="menu" />
          </button>
          <button type="button" className="modelpill" onClick={() => setSheet("model")} aria-label="モデルを選ぶ">
            {pillProvider ? (
              <ProviderTile pid={pillProvider.id} mono={pillProvider.mono} color={pillProvider.color} />
            ) : (
              <ProviderTile mono="Au" color="#2563eb" />
            )}
            <span className="mp-name">{conf.provider === "auto" ? "Eluntra Auto" : pillProvider?.name}</span>
            <span className="mp-model">{conf.provider === "auto" ? "自動選択" : target.model}</span>
            <Icon name="chevron" className="ic sm" />
          </button>
          <span className="spacer" />
          {conf.mode === "code" && (
            <button type="button" className="btn secondary sm only-sp" onClick={() => setCodeShow(true)}>
              プレビュー
            </button>
          )}
          <button type="button" className="iconbtn" aria-label="設定" onClick={() => setSheet("settings")}>
            <Icon name="gear" />
          </button>
        </header>

        {conf.mode === "code" ? (
          <div className="code-wrap">
            <div className="code-split">
              <div className="code-chat">
                <ChatPane
                  session={session}
                  generating={generating}
                  targetLabel={{ providerId: target.providerId, ok: target.ok }}
                  onSend={(t, a) => void send(t, a)}
                  onStop={stop}
                  onRegenerate={regenerate}
                  onEditUser={editUser}
                  onOpenSettings={() => setSheet("settings")}
                  toast={toast}
                  draft={editDraft}
                  placeholder="作りたいサイトやアプリを伝えてください"
                />
              </div>
              <CodePreview sessionId={session?.id ?? null} show={codeShow} onClose={() => setCodeShow(false)} />
            </div>
          </div>
        ) : (
          <ChatPane
            session={session}
            generating={generating}
            targetLabel={{ providerId: target.providerId, ok: target.ok }}
            onSend={(t, a) => void send(t, a)}
            onStop={stop}
            onRegenerate={regenerate}
            onEditUser={editUser}
            onOpenSettings={() => setSheet("settings")}
            toast={toast}
            draft={editDraft}
          />
        )}
      </div>

      <ModelSheet open={sheet === "model"} onClose={() => setSheet("none")} toast={toast} />
      <Settings
        open={sheet === "settings"}
        onClose={() => setSheet("none")}
        toast={toast}
        onLogoutToWelcome={() => setEntered(false)}
      />
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </div>
  );
}
