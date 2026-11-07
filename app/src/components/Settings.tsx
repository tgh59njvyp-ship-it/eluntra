import { useState } from "react";
import { currentUser, isLoggedIn, loginWith, logout, pushSync, type OAuthProvider } from "../lib/auth";
import { CONNECTORS, testConnector } from "../lib/connectors/registry";
import { fetchModels, testConnection } from "../lib/providers/chat";
import { PROVIDERS, findProvider } from "../lib/providers/registry";

import {
  getState, joinKeyFields, keyFieldsOf, keyStateLabel, keyStateOf, resetAllData, update, useStore,
} from "../lib/store";
import type { ProviderDef } from "../lib/types";
import { Icon, ProviderTile } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  toast: (msg: string) => void;
  onLogoutToWelcome: () => void;
}

function maskValue(v: string): string {
  if (!v) return "";
  if (v.length <= 6) return "••••";
  return `${v.slice(0, 3)}••••${v.slice(-3)}`;
}

function ProviderItem({ p, toast }: { p: ProviderDef; toast: (m: string) => void }) {
  const savedRaw = useStore((s) => s.keys[p.id]) || "";
  const stateKind = useStore((s) => keyStateOf(p.id));
  void savedRaw;
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(() => keyFieldsOf(p.id, getState().keys[p.id] || ""));
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  const save = () => {
    const st = getState();
    const joined = joinKeyFields(p.id, draft);
    const next = { ...st.keys };
    if (joined) next[p.id] = joined;
    else delete next[p.id];
    const tested = { ...st.tested };
    delete tested[p.id];
    update({ keys: next, tested });
    toast(joined ? `${p.name}のキーを保存しました` : `${p.name}のキーを削除しました`);
  };

  const doTest = async () => {
    save();
    setTesting(true);
    setTestMsg(null);
    const r = await testConnection(p);
    setTestMsg(r);
    setTesting(false);
  };

  const doFetch = async () => {
    save();
    setTesting(true);
    try {
      const ids = await fetchModels(p);
      setTestMsg({ ok: true, msg: `モデルを${ids.length}件取得しました` });
    } catch (e) {
      setTestMsg({ ok: false, msg: e instanceof Error ? e.message : "取得に失敗しました" });
    }
    setTesting(false);
  };

  const fields = p.fields?.length
    ? p.fields
    : [{ id: "key", label: "APIキー", secret: true, placeholder: p.keyHint }];

  return (
    <div className="prov-item">
      <button type="button" className="prov-head" onClick={() => setExpanded(!expanded)}>
        <ProviderTile pid={p.id} mono={p.mono} color={p.color} />
        <span style={{ flex: 1 }}>
          <span className="nm">{p.name}</span>
          <br />
          <span className="st" style={{ color: stateKind === "ok" ? "var(--success)" : "var(--text-3)" }}>
            {keyStateLabel(p.id)}
            {savedRaw && !p.fields ? ` ・ ${maskValue(savedRaw)}` : ""}
          </span>
        </span>
        <Icon name="chevron" className="ic sm" />
      </button>
      {expanded && (
        <div className="prov-body">
          {p.note && <p className="set-desc">{p.note}</p>}
          {fields.map((f) => (
            <div className="field" key={f.id}>
              <label htmlFor={`key-${p.id}-${f.id}`}>{f.label}</label>
              <input
                id={`key-${p.id}-${f.id}`}
                className="key-input"
                type={f.secret && !showSecret ? "password" : "text"}
                placeholder={f.placeholder}
                value={draft[f.id] || ""}
                onChange={(e) => setDraft({ ...draft, [f.id]: e.target.value })}
                autoComplete="off"
              />
              {(f.hint || (f.id === "key" && !p.fields ? p.keyHint : "")) && (
                <div className="hint">{f.hint || p.keyHint}</div>
              )}
            </div>
          ))}
          <div style={{ display: "flex", gap: 14, fontSize: 13 }}>
            <a href={p.keyUrl} target="_blank" rel="noopener noreferrer">
              キーを取得する <Icon name="ext" className="ic sm" />
            </a>
            <button type="button" className="btn ghost sm" onClick={() => setShowSecret(!showSecret)} style={{ height: "auto", padding: 0 }}>
              {showSecret ? "隠す" : "キーを表示"}
            </button>
          </div>
          <div className="rowbtns">
            <button type="button" className="btn primary sm" onClick={save}>保存</button>
            <button type="button" className="btn secondary sm" onClick={doTest} disabled={testing}>
              {testing ? "確認中…" : "接続テスト"}
            </button>
            <button type="button" className="btn secondary sm" onClick={doFetch} disabled={testing}>
              一覧を取得
            </button>
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setDraft({});
                const st = getState();
                const next = { ...st.keys };
                delete next[p.id];
                const tested = { ...st.tested };
                delete tested[p.id];
                update({ keys: next, tested });
                setTestMsg(null);
              }}
            >
              削除
            </button>
          </div>
          {testMsg && <div className={`testmsg ${testMsg.ok ? "ok" : "ng"}`}>{testMsg.msg}</div>}
        </div>
      )}
    </div>
  );
}

function ConnectorItem({ id, name, mono, color, supported, fieldLabel, fieldPlaceholder, help, toast }: {
  id: string; name: string; mono: string; color: string; supported: boolean;
  fieldLabel?: string; fieldPlaceholder?: string; help?: string; toast: (m: string) => void;
}) {
  const saved = useStore((s) => s.connectors[id]) || "";
  const [draft, setDraft] = useState(saved);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="prov-item">
      <div className="prov-head" style={{ cursor: "default" }}>
        <ProviderTile mono={mono} color={color} />
        <span style={{ flex: 1 }}>
          <span className="nm">{name}</span>
          <br />
          <span className="st" style={{ color: "var(--text-3)" }}>
            {!supported ? "未対応（OAuthアプリの登録が必要なため）" : saved ? "トークン設定済み" : "未接続"}
          </span>
        </span>
      </div>
      {supported && (
        <div className="prov-body">
          {help && <p className="set-desc">{help}</p>}
          <div className="field">
            <label>{fieldLabel}</label>
            <input
              className="key-input"
              type="password"
              placeholder={fieldPlaceholder}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="rowbtns">
            <button
              type="button"
              className="btn primary sm"
              onClick={() => {
                const st = getState();
                const next = { ...st.connectors };
                if (draft.trim()) next[id] = draft.trim();
                else delete next[id];
                update({ connectors: next });
                toast(`${name}のトークンを保存しました`);
              }}
            >
              保存
            </button>
            <button
              type="button"
              className="btn secondary sm"
              disabled={busy}
              onClick={async () => {
                const st = getState();
                update({ connectors: { ...st.connectors, [id]: draft.trim() } });
                setBusy(true);
                const r = await testConnector(id);
                setMsg(r);
                setBusy(false);
              }}
            >
              {busy ? "確認中…" : "接続テスト"}
            </button>
          </div>
          {msg && <div className={`testmsg ${msg.ok ? "ok" : "ng"}`}>{msg.msg}</div>}
        </div>
      )}
    </div>
  );
}

export function Settings({ open, onClose, toast, onLogoutToWelcome }: Props) {
  const conf = useStore((s) => s.conf);
  const theme = useStore((s) => s.theme);
  const notes = useStore((s) => s.notes);
  const user = currentUser();
  const loggedIn = isLoggedIn();
  const [syncMsg, setSyncMsg] = useState("");

  const setConf = (patch: Partial<typeof conf>) => {
    update({ conf: { ...getState().conf, ...patch } });
  };

  return (
    <>
      <div className={`sheet-back${open ? " on" : ""}`} onClick={onClose} />
      <section className={`sheet wideSheet${open ? " on" : ""}`} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>設定</h2>
          <span className="pill-state">現在の版：v6.1</span>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="閉じる">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">
          <div className="set-sec">アカウント</div>
          {loggedIn && user ? (
            <>
              <p className="set-desc">
                {user.name || user.email || "ログイン中"}（{user.provider}）でログインしています。会話と設定はクラウド同期されます（APIキーは同期されません）。
              </p>
              <div className="rowbtns">
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={async () => {
                    const ok = await pushSync();
                    setSyncMsg(ok ? "同期しました" : "同期に失敗しました。電波を確認してください");
                  }}
                >
                  今すぐ同期
                </button>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={async () => {
                    await logout();
                    onLogoutToWelcome();
                    onClose();
                  }}
                >
                  ログアウト
                </button>
              </div>
              {syncMsg && <div className="testmsg ok">{syncMsg}</div>}
            </>
          ) : (
            <>
              <p className="set-desc">ログインすると会話と設定が端末間で同期されます。APIキーは端末内にのみ保存され、同期されません。</p>
              <div className="rowbtns">
                {(["github", "google", "apple"] as OAuthProvider[]).map((pr) => (
                  <button key={pr} type="button" className="btn secondary sm" onClick={() => void loginWith(pr)}>
                    {pr === "github" ? "GitHub" : pr === "google" ? "Google" : "Apple"}でログイン
                  </button>
                ))}
              </div>
              <p className="set-desc">Googleログインはテスト中のため、当面は許可されたアカウントのみ使えます。Appleは未有効化の場合があります。</p>
            </>
          )}

          <div className="set-sec">テーマ</div>
          <div className="rowbtns" style={{ marginTop: 0 }}>
            <button type="button" className={`btn sm ${theme === "light" ? "primary" : "secondary"}`} onClick={() => update({ theme: "light" })}>
              <Icon name="sun" className="ic sm" /> ライト（標準）
            </button>
            <button type="button" className={`btn sm ${theme === "dark" ? "primary" : "secondary"}`} onClick={() => update({ theme: "dark" })}>
              <Icon name="moon" className="ic sm" /> ダーク
            </button>
          </div>

          <div className="set-sec">接続</div>
          <div className="switch-row">
            <div className="grow">
              <div className="ttl">サーバー経由で接続</div>
              <div className="dsc">ブラウザから直接つなげない会社（SambaNova等）のために中継サーバーを通します。キーは中継サーバーに保存・記録されません。</div>
            </div>
            <input type="checkbox" checked={conf.proxyOn} onChange={(e) => setConf({ proxyOn: e.target.checked })} aria-label="サーバー経由で接続" />
          </div>
          <div className="switch-row">
            <div className="grow">
              <div className="ttl">Agent Mode（既定）</div>
              <div className="dsc">オンにすると送信がエージェント実行になります。入力欄のボタンでも切り替えられます。</div>
            </div>
            <input type="checkbox" checked={conf.agent} onChange={(e) => setConf({ agent: e.target.checked })} aria-label="Agent Mode" />
          </div>

          <div className="set-sec">チャット設定</div>
          <div className="field">
            <label htmlFor="sys-prompt">システムプロンプト</label>
            <textarea
              id="sys-prompt"
              className="text-input"
              value={conf.system}
              onChange={(e) => setConf({ system: e.target.value })}
              placeholder="例：関西弁で答えてください"
            />
          </div>
          <div className="field">
            <label htmlFor="temp-range">温度（創造性）：{conf.temp.toFixed(1)}</label>
            <input
              id="temp-range"
              type="range"
              min={0}
              max={1.5}
              step={0.1}
              value={conf.temp}
              onChange={(e) => setConf({ temp: Number(e.target.value) })}
              style={{ width: "100%" }}
            />
            <div className="hint">Eluntra Autoは、質問の種類・思考レベル・接続テストの状態から自動で選びます。選択理由は回答に表示されます。</div>
          </div>

          <div className="set-sec">APIプロバイダー（30社）</div>
          <p className="set-desc">キーは端末内にのみ保存されます。複数社のキーを入れておくと、Eluntra Autoや自動フォールバックで使い分けられます。</p>
          {PROVIDERS.map((p) => (
            <ProviderItem key={`${open}-${p.id}`} p={p} toast={toast} />
          ))}

          <div className="set-sec">コネクタ（16種）</div>
          <p className="set-desc">トークン方式で動作する5種のみ実働です。残りはOAuthアプリの登録が必要なため未対応と表示しています。トークンは端末内にのみ保存されます。</p>
          {CONNECTORS.map((c) => (
            <ConnectorItem key={`${open}-${c.id}`} {...c} toast={toast} />
          ))}

          <div className="set-sec">メモ（エージェントが保存）</div>
          {notes.length === 0 && <p className="set-desc">メモはまだありません。Agent Modeで調査すると保存されることがあります。</p>}
          {notes.map((n) => (
            <div key={n.id} className="prov-item" style={{ padding: "10px 12px" }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{n.title}</div>
              <div style={{ fontSize: 13, color: "var(--text-2)", whiteSpace: "pre-wrap" }}>{n.content.slice(0, 300)}</div>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => update({ notes: getState().notes.filter((x) => x.id !== n.id) })}
              >
                削除
              </button>
            </div>
          ))}

          <div className="set-sec">データ管理</div>
          <p className="set-desc">キー・会話・設定・メモなど、この端末に保存されたEluntraのデータをすべて削除します（クラウド側の同期データは対象外です）。</p>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => {
              if (window.confirm("この端末のEluntraデータをすべて削除しますか？")) {
                resetAllData();
                toast("データを削除しました");
                onClose();
              }
            }}
          >
            すべてのデータを削除
          </button>
          <p className="set-desc" style={{ marginTop: 18 }}>
            現在のプロバイダーは {conf.provider === "auto" ? "Eluntra Auto" : findProvider(conf.provider).name} です。
          </p>
        </div>
      </section>
    </>
  );
}

