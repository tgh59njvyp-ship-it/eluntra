import { useEffect, useRef, useState } from "react";
import { currentUser, isLoggedIn, loginWith, logout, pushSync, type OAuthProvider } from "../lib/auth";
import {
  OAUTH_SERVICES, REDIRECT_URI, disconnectConnector, githubDevicePoll, githubDeviceStart,
  oauthReady, saveConnectorToken, startOAuth,
} from "../lib/connectors/oauth";
import { CONNECTORS, testConnector } from "../lib/connectors/registry";
import { fetchModels, testConnection } from "../lib/providers/chat";
import { PROVIDERS } from "../lib/providers/registry";

import {
  customDef, getState, joinKeyFields, keyFieldsOf, keyStateLabel, keyStateOf, newCustomId, providerDefOf, resetAllData, update, useStore,
} from "../lib/store";
import type { CustomEntry, ProviderDef } from "../lib/types";
import { ConnectorTile, Icon, ProviderTile } from "./icons";
import { MigrateSection } from "./MigrateSection";

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
            {p.keyUrl && (
              <a href={p.keyUrl} target="_blank" rel="noopener noreferrer">
                キーを取得する <Icon name="ext" className="ic sm" />
              </a>
            )}
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

function CustomItem({ entry, toast, defaultExpanded = false }: { entry: CustomEntry; toast: (m: string) => void; defaultExpanded?: boolean }) {
  const stateKind = useStore((s) => keyStateOf(entry.id));
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [draft, setDraft] = useState({ name: entry.name, base: entry.base, key: entry.key });
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  const save = (): CustomEntry => {
    const st = getState();
    const next: CustomEntry = {
      id: entry.id,
      name: draft.name.trim() || entry.name || "カスタム",
      base: draft.base.trim(),
      key: draft.key.trim(),
    };
    update({
      customs: st.customs.map((c) => (c.id === entry.id ? next : c)),
      tested: Object.fromEntries(Object.entries(st.tested).filter(([k]) => k !== entry.id)),
    });
    return next;
  };

  const doSave = () => {
    save();
    toast(`「${draft.name.trim() || entry.name}」を保存しました`);
  };

  const doTest = async () => {
    const saved = save();
    setTesting(true);
    setTestMsg(null);
    const r = await testConnection(customDef(saved));
    setTestMsg(r);
    setTesting(false);
  };

  const doFetch = async () => {
    const saved = save();
    setTesting(true);
    try {
      const ids = await fetchModels(customDef(saved));
      setTestMsg({ ok: true, msg: `モデルを${ids.length}件取得しました` });
    } catch (e) {
      setTestMsg({ ok: false, msg: e instanceof Error ? e.message : "取得に失敗しました" });
    }
    setTesting(false);
  };

  const doDelete = () => {
    if (!window.confirm(`「${entry.name}」を削除しますか？`)) return;
    const st = getState();
    const fetchedModels = { ...st.fetchedModels };
    delete fetchedModels[entry.id];
    const modelFlags = { ...st.modelFlags };
    delete modelFlags[entry.id];
    const tested = { ...st.tested };
    delete tested[entry.id];
    const models = { ...st.conf.models };
    delete models[entry.id];
    update({
      customs: st.customs.filter((c) => c.id !== entry.id),
      fetchedModels,
      modelFlags,
      tested,
      conf: {
        ...st.conf,
        models,
        provider: st.conf.provider === entry.id ? "gemini" : st.conf.provider,
      },
    });
    toast(`「${entry.name}」を削除しました`);
  };

  const def = customDef(entry);

  return (
    <div className="prov-item">
      <button type="button" className="prov-head" onClick={() => setExpanded(!expanded)}>
        <ProviderTile pid="custom" mono={def.mono} color={def.color} />
        <span style={{ flex: 1 }}>
          <span className="nm">{entry.name}</span>
          <br />
          <span className="st" style={{ color: stateKind === "ok" ? "var(--success)" : "var(--text-3)" }}>
            {keyStateLabel(entry.id)}
            {entry.base ? ` ・ ${entry.base}` : ""}
          </span>
        </span>
        <Icon name="chevron" className="ic sm" />
      </button>
      {expanded && (
        <div className="prov-body">
          <p className="set-desc">
            OpenAI互換エンドポイントへの接続です。通信はEluntraのサーバー経由で中継するため、ブラウザからの直接アクセス（CORS）を許可していない接続先でも使えます。
          </p>
          <div className="field">
            <label htmlFor={`custom-name-${entry.id}`}>名前</label>
            <input
              id={`custom-name-${entry.id}`}
              className="key-input"
              type="text"
              placeholder="例：私のOpenRouter"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label htmlFor={`custom-base-${entry.id}`}>ベースURL</label>
            <input
              id={`custom-base-${entry.id}`}
              className="key-input"
              type="text"
              placeholder="https://example.com/v1"
              value={draft.base}
              onChange={(e) => setDraft({ ...draft, base: e.target.value })}
              autoComplete="off"
            />
            <div className="hint">OpenAI互換エンドポイントのURL（末尾の /v1 まで）</div>
          </div>
          <div className="field">
            <label htmlFor={`custom-key-${entry.id}`}>APIキー</label>
            <input
              id={`custom-key-${entry.id}`}
              className="key-input"
              type={showSecret ? "text" : "password"}
              placeholder="キー不要の場合は空欄でOK"
              value={draft.key}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              autoComplete="off"
            />
          </div>
          <div style={{ display: "flex", gap: 14, fontSize: 13 }}>
            <button type="button" className="btn ghost sm" onClick={() => setShowSecret(!showSecret)} style={{ height: "auto", padding: 0 }}>
              {showSecret ? "隠す" : "キーを表示"}
            </button>
          </div>
          <div className="rowbtns">
            <button type="button" className="btn primary sm" onClick={doSave}>保存</button>
            <button type="button" className="btn secondary sm" onClick={doTest} disabled={testing}>
              {testing ? "確認中…" : "接続テスト"}
            </button>
            <button type="button" className="btn secondary sm" onClick={doFetch} disabled={testing}>
              一覧を取得
            </button>
            <button type="button" className="btn ghost sm" onClick={doDelete}>
              削除
            </button>
          </div>
          {testMsg && <div className={`testmsg ${testMsg.ok ? "ok" : "ng"}`}>{testMsg.msg}</div>}
        </div>
      )}
    </div>
  );
}

function ConnectorItem({ id, name, mono, color, supported, desc, fieldLabel, fieldPlaceholder, help, toast }: {
  id: string; name: string; mono: string; color: string; supported: boolean; desc: string;
  fieldLabel?: string; fieldPlaceholder?: string; help?: string; toast: (m: string) => void;
}) {
  const saved = useStore((s) => s.connectors[id]) || "";
  const account = useStore((s) => s.connectorAccounts[id]) || "";
  const connected = !!saved;
  const [panel, setPanel] = useState(false);
  const [draft, setDraft] = useState(saved);
  const [msg, setMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // GitHubデバイスフローの状態
  const [devPhase, setDevPhase] = useState<"idle" | "starting" | "waiting" | "disabled" | "error">("idle");
  const [devCode, setDevCode] = useState("");
  const [devMsg, setDevMsg] = useState("");
  const pollStop = useRef(false);

  useEffect(() => () => { pollStop.current = true; }, []);

  const startDeviceFlow = async () => {
    setDevPhase("starting");
    setDevMsg("");
    const r = await githubDeviceStart();
    if (!r.ok) {
      if (r.disabled) {
        setDevPhase("disabled");
        setDevMsg("このGitHubアプリではデバイスフローがまだ有効化されていません（GitHubの実測エラー：device_flow_disabled）。");
      } else {
        setDevPhase("error");
        setDevMsg(r.message || "開始できませんでした");
      }
      return;
    }
    setDevCode(r.userCode || "");
    setDevPhase("waiting");
    pollStop.current = false;
    let interval = (r.interval || 5) * 1000;
    const poll = async () => {
      if (pollStop.current) return;
      const pr = await githubDevicePoll(r.deviceCode || "");
      if (pollStop.current) return;
      if (pr.status === "authorized") {
        saveConnectorToken(id, pr.token, pr.account);
        toast(pr.account ? `GitHubに ${pr.account} として接続しました` : "GitHubに接続しました");
        setPanel(false);
        setDevPhase("idle");
        return;
      }
      if (pr.status === "error") {
        setDevPhase("error");
        setDevMsg(pr.message);
        return;
      }
      if (pr.status === "slow_down") interval += 2000;
      window.setTimeout(() => void poll(), interval);
    };
    window.setTimeout(() => void poll(), interval);
  };

  const svc = OAUTH_SERVICES[id];
  const statusText = connected
    ? account ? `${account} として接続中` : "接続中"
    : id === "github"
      ? "ログインで接続（GitHub側でデバイスフローの有効化が必要）"
      : id === "supabase"
        ? "トークンで接続できます（ログイン式は準備中）"
        : "準備中（アプリ登録が必要）";

  /* Supabase トークン式接続（プロジェクトURL＋サービスロールキー＋任意でsbp_） */
  const [sbUrl, setSbUrl] = useState("");
  const [sbServiceKey, setSbServiceKey] = useState("");
  const [sbSbp, setSbSbp] = useState("");
  useEffect(() => {
    if (id !== "supabase" || !panel) return;
    const raw = (getState().connectors["supabase"] || "").trim();
    if (raw.startsWith("{")) {
      try {
        const j = JSON.parse(raw) as { url?: string; serviceKey?: string; sbp?: string };
        setSbUrl(j.url || "");
        setSbServiceKey(j.serviceKey || "");
        setSbSbp(j.sbp || "");
      } catch { /* 壊れた保存値は無視する */ }
    }
  }, [id, panel]);

  const saveSupabase = () => {
    const st = getState();
    const next = { ...st.connectors };
    const obj = {
      url: sbUrl.trim().replace(/\/+$/, ""),
      serviceKey: sbServiceKey.trim(),
      sbp: sbSbp.trim(),
    };
    if (!obj.url && !obj.serviceKey && !obj.sbp) {
      /* 空保存でログイン式のトークンを消さない（トークン式の保存値だけ消す） */
      if ((next[id] || "").trim().startsWith("{")) delete next[id];
    } else {
      next[id] = JSON.stringify(obj);
    }
    update({ connectors: next });
  };

  const testSupabase = async () => {
    saveSupabase();
    setBusy(true);
    const r = await testConnector("supabase");
    if (r.ok) {
      const m = sbUrl.match(/https:\/\/([a-z0-9-]+)\.supabase\.co/i);
      if (m) {
        update({ connectorAccounts: { ...getState().connectorAccounts, [id]: `プロジェクト ${m[1]}` } });
      }
    }
    setMsg(r);
    setBusy(false);
  };

  return (
    <div className="prov-item">
      <div className="prov-head" style={{ cursor: "default" }}>
        <ConnectorTile cid={id} mono={mono} color={color} />
        <span style={{ flex: 1 }}>
          <span className="nm">{name}</span>
          <br />
          <span className="st" style={{ color: connected ? "var(--success, #1E6B4A)" : "var(--text-3)" }}>
            {statusText}
          </span>
          <br />
          <span className="st" style={{ color: "var(--text-3)" }}>{desc}</span>
        </span>
        {connected ? (
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => { disconnectConnector(id); toast(`${name}を切断しました`); }}
          >
            切断
          </button>
        ) : (
          <button type="button" className="btn primary sm" onClick={() => setPanel((v) => !v)}>
            接続
          </button>
        )}
      </div>
      {!connected && panel && (
        <div className="prov-body">
          {id === "github" ? (
            <>
              <p className="set-desc">
                「GitHubを開く」→ GitHubの画面でログインしてコードを入れるだけで繋がる方式（デバイスフロー）に対応しています。
                ただし現在は、ログインで使っているGitHubアプリ側でデバイスフローが有効化されていないため開始できません（2026-11-08に実測で確認）。
              </p>
              <p className="set-desc">
                有効化の手順（アプリの管理者のみ、1回だけ）：GitHub → Settings → Developer settings → 対象のアプリ →
                「Allow device flow（デバイスフローを許可）」をオンにする。有効化されれば、下のボタンからそのまま接続できます。
              </p>
              {devPhase === "waiting" ? (
                <div className="conn-device">
                  <div className="conn-code">{devCode}</div>
                  <p className="set-desc">GitHubの画面でこのコードを入力してください。入力が完了すると自動で接続します。</p>
                  <div className="rowbtns">
                    <a className="btn primary sm" href="https://github.com/login/device" target="_blank" rel="noopener noreferrer">
                      GitHubを開く
                    </a>
                    <span className="pill-state">承認待ち…</span>
                  </div>
                </div>
              ) : (
                <div className="rowbtns">
                  <button type="button" className="btn secondary sm" disabled={devPhase === "starting"} onClick={() => void startDeviceFlow()}>
                    {devPhase === "starting" ? "確認中…" : "接続をはじめる（状態を確認）"}
                  </button>
                </div>
              )}
              {devPhase === "disabled" && <div className="testmsg ng">{devMsg}</div>}
              {devPhase === "error" && <div className="testmsg ng">{devMsg}</div>}
            </>
          ) : (
            <>
              <p className="set-desc">
                この接続には、各サービスの開発者画面での1回限りのアプリ登録（リダイレクト先
                <code> {REDIRECT_URI} </code>
                とクライアント情報の登録）が必要です。登録が済むとこのボタンからログインだけで繋がります。
              </p>
              {svc?.note && <p className="set-desc">{svc.note}</p>}
              {oauthReady(id) ? (
                <div className="rowbtns">
                  <button type="button" className="btn primary sm" onClick={() => void startOAuth(id)}>
                    {name}のログイン画面を開く
                  </button>
                </div>
              ) : (
                <span className="pill-state">準備中：アプリ登録が完了するまでログイン接続は開始できません</span>
              )}
            </>
          )}
          {supported && id !== "supabase" && (
            <details className="conn-fallback">
              <summary>トークンで接続（上級者向け）</summary>
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
                    if (r.ok && id === "github") {
                      const m = r.msg.match(/@[A-Za-z0-9-]+/);
                      if (m) update({ connectorAccounts: { ...getState().connectorAccounts, [id]: m[0] } });
                    }
                    setMsg(r);
                    setBusy(false);
                  }}
                >
                  {busy ? "確認中…" : "接続テスト"}
                </button>
              </div>
              {msg && <div className={`testmsg ${msg.ok ? "ok" : "ng"}`}>{msg.msg}</div>}
            </details>
          )}
          {id === "supabase" && (
            <details className="conn-fallback">
              <summary>トークンで接続（上級者向け）</summary>
              <p className="set-desc">
                Supabase の Settings → API で確認できる「プロジェクトURL」と「サービスロールキー（service_role）」を入力します。
                接続すると、エージェントがテーブル操作（読み書き）・認証ユーザーの管理を行えます。
              </p>
              <p className="set-desc">
                サービスロールキーはデータベースへのフルアクセス権限を持つ重要なキーです。この端末に保存され、ログイン中は他の接続情報と同様に、あなたのSupabaseアカウントの専用領域（自分の行だけ読み書き可能）にも同期されます。
                アクセストークン（sbp_）も入れると、エージェントが SQL も実行できます（URL＋サービスロールキーだけでも接続できます）。
              </p>
              <div className="field">
                <label>プロジェクトURL</label>
                <input
                  className="key-input"
                  type="text"
                  placeholder="https://xxxxx.supabase.co"
                  value={sbUrl}
                  onChange={(e) => setSbUrl(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label>サービスロールキー（service_role）</label>
                <input
                  className="key-input"
                  type="password"
                  placeholder="eyJ…（service_role キー）"
                  value={sbServiceKey}
                  onChange={(e) => setSbServiceKey(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="field">
                <label>アクセストークン（任意・SQL実行用）</label>
                <input
                  className="key-input"
                  type="password"
                  placeholder="sbp_…"
                  value={sbSbp}
                  onChange={(e) => setSbSbp(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="rowbtns">
                <button
                  type="button"
                  className="btn primary sm"
                  onClick={() => {
                    saveSupabase();
                    toast("Supabaseの接続情報を保存しました");
                  }}
                >
                  保存
                </button>
                <button
                  type="button"
                  className="btn secondary sm"
                  disabled={busy}
                  onClick={() => void testSupabase()}
                >
                  {busy ? "確認中…" : "接続テスト"}
                </button>
              </div>
              {msg && <div className={`testmsg ${msg.ok ? "ok" : "ng"}`}>{msg.msg}</div>}
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function Settings({ open, onClose, toast, onLogoutToWelcome }: Props) {
  const conf = useStore((s) => s.conf);
  const theme = useStore((s) => s.theme);
  const notes = useStore((s) => s.notes);
  const customs = useStore((s) => s.customs);
  const user = currentUser();
  const loggedIn = isLoggedIn();
  const [syncMsg, setSyncMsg] = useState("");
  const [freshCustomId, setFreshCustomId] = useState<string | null>(null);

  const addCustom = () => {
    const st = getState();
    let n = st.customs.length + 1;
    const names = new Set(st.customs.map((c) => c.name));
    while (names.has(`カスタム${n}`)) n += 1;
    const entry: CustomEntry = { id: newCustomId(), name: `カスタム${n}`, base: "", key: "" };
    update({ customs: [...st.customs, entry] });
    setFreshCustomId(entry.id);
  };

  const setConf = (patch: Partial<typeof conf>) => {
    update({ conf: { ...getState().conf, ...patch } });
  };

  return (
    <>
      <div className={`sheet-back${open ? " on" : ""}`} onClick={onClose} />
      <section className={`sheet wideSheet${open ? " on" : ""}`} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>設定</h2>
          <span className="pill-state">現在の版：v7.2.1</span>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="閉じる">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">
          <div className="set-sec">アカウント</div>
          {loggedIn && user ? (
            <>
              <p className="set-desc">
                {user.name || user.email || "ログイン中"}（{user.provider}）でログインしています。会話・設定に加えて、APIキー・カスタム接続・コネクタの接続情報もあなたのSupabaseアカウントの専用領域（自分の行だけ読み書き可能）に同期され、ログインした端末へ引き継がれます。ログアウトしてもクラウド側のデータは消えず、次回ログインで戻ります。
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
              <p className="set-desc">ログインすると、会話・設定・APIキー・カスタム接続・コネクタの接続情報があなたのSupabaseアカウントの専用領域（自分の行だけ読み書き可能）に保存され、別の端末でもログインするだけで引き継げます。未ログインの間は、この端末内にのみ保存されます。</p>
              <div className="rowbtns">
                {(["github", "google"] as OAuthProvider[]).map((pr) => (
                  <button key={pr} type="button" className="btn secondary sm" onClick={() => void loginWith(pr)}>
                    {pr === "github" ? "GitHub" : "Google"}でログイン
                  </button>
                ))}
                <button type="button" className="btn secondary sm" disabled aria-disabled="true" style={{ opacity: 0.55 }}>
                  Appleでログイン（準備中）
                </button>
              </div>
              <p className="set-desc">Googleログインはテスト中のため、当面は許可されたアカウントのみ使えます。Appleログインはサーバー側で未有効化のため準備中です。</p>
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
          <p className="set-desc">キーはこの端末に保存され、ログイン中はあなたのSupabaseアカウントの専用領域にも同期され、ログインした端末へ引き継がれます。複数社のキーを入れておくと、Eluntra Autoや自動フォールバックで使い分けられます。</p>
          {PROVIDERS.map((p) => (
            <ProviderItem key={`${open}-${p.id}`} p={p} toast={toast} />
          ))}

          <div className="set-sec">カスタムプロバイダー</div>
          <p className="set-desc">OpenAI互換の接続先を、何件でも自分で追加できます。名前は自由に付けられます。通信はEluntraのサーバー経由で中継するため、CORSを許可していない接続先でも使えます。URLとキーはこの端末に保存され、ログイン中はアカウントにも同期されます。</p>
          {customs.length === 0 && (
            <p className="set-desc">まだありません。「追加」から自分の接続先を作れます。</p>
          )}
          {customs.map((entry) => (
            <CustomItem
              key={`${open}-${entry.id}`}
              entry={entry}
              toast={toast}
              defaultExpanded={entry.id === freshCustomId}
            />
          ))}
          <div className="rowbtns">
            <button type="button" className="btn secondary sm" onClick={addCustom}>
              ＋ カスタムを追加
            </button>
          </div>

          <div className="set-sec">コネクタ（17種）</div>
          <p className="set-desc">「接続」を押すとログイン画面でつなぐ方式が基本です。GitHubはデバイスフローに対応していますが、GitHubアプリ側で有効化が必要です。その他のサービスは各サービスの開発者画面でのアプリ登録（1回限り）が済むまで「準備中」と表示します。トークンで接続できるもの（GitHub / YouTube / Notion / Slack / Discord の5種と Supabase）は、各行の「トークンで接続（上級者向け）」から従来どおり使えます。Supabaseを接続すると、エージェントがデータベース操作や認証ユーザー管理を行えます。接続情報はこの端末に保存され、ログイン中はアカウントにも同期されます。</p>
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

          <MigrateSection />

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
            現在のプロバイダーは {conf.provider === "auto" ? "Eluntra Auto" : providerDefOf(conf.provider)?.name ?? "（未設定）"} です。
          </p>
        </div>
      </section>
    </>
  );
}

