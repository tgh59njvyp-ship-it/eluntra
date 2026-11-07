import { useEffect, useMemo, useState } from "react";
import { fetchModels } from "../lib/providers/chat";
import { PROVIDERS, findProvider } from "../lib/providers/registry";
import { UserError } from "../lib/providers/transport";
import {
  getState, keyStateLabel, keyStateOf, modelListOf, pushRecent, toggleFavorite, update, useStore,
} from "../lib/store";
import { Icon, ProviderTile } from "./icons";

interface Props {
  open: boolean;
  onClose: () => void;
  toast: (msg: string) => void;
}

export function ModelSheet({ open, onClose, toast }: Props) {
  const conf = useStore((s) => s.conf);
  const fetchedModels = useStore((s) => s.fetchedModels);
  const modelMeta = useStore((s) => s.modelMeta);
  const favorites = useStore((s) => s.favorites);
  const recents = useStore((s) => s.recents);
  void fetchedModels;
  const [providerId, setProviderId] = useState<string>("gemini");
  const [query, setQuery] = useState("");
  const [onlyReady, setOnlyReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState("");

  useEffect(() => {
    if (open) {
      setProviderId(conf.provider === "auto" ? "gemini" : conf.provider);
      setQuery("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const isAuto = conf.provider === "auto";
  const provider = findProvider(providerId);
  const models = modelListOf(providerId);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = models.filter((m) => !q || m.toLowerCase().includes(q));
    // お気に入りを先に
    const favs = favorites[providerId] || [];
    return [...list.filter((m) => favs.includes(m)), ...list.filter((m) => !favs.includes(m))];
  }, [models, query, favorites, providerId]);

  const recentPairs = recents
    .map((r) => {
      const [pid, ...rest] = r.split(":");
      return { pid, model: rest.join(":") };
    })
    .filter((r) => PROVIDERS.some((p) => p.id === r.pid));

  const choose = (pid: string, model: string) => {
    const st = getState();
    update({
      conf: {
        ...st.conf,
        provider: pid,
        models: { ...st.conf.models, [pid]: model },
      },
    });
    pushRecent(pid, model);
    onClose();
  };

  const chooseAuto = () => {
    const st = getState();
    update({ conf: { ...st.conf, provider: "auto" } });
    onClose();
  };

  const doFetch = async () => {
    setBusy(true);
    try {
      const ids = await fetchModels(provider);
      toast(`${provider.name}のモデルを${ids.length}件取得しました`);
    } catch (e) {
      toast(e instanceof UserError || e instanceof Error ? e.message : "取得に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  const meta = modelMeta[providerId];
  const visibleProviders = PROVIDERS.filter((p) => !onlyReady || keyStateOf(p.id) !== "none");

  return (
    <>
      <div className={`sheet-back${open ? " on" : ""}`} onClick={onClose} />
      <section className={`sheet${open ? " on" : ""}`} aria-hidden={!open}>
        <div className="sheet-head">
          <h2>モデルを選ぶ</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="閉じる">
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">
          <label className="tool-toggle" style={{ marginBottom: 12, cursor: "pointer" }}>
            <input type="checkbox" checked={onlyReady} onChange={(e) => setOnlyReady(e.target.checked)} />
            接続済みのみ表示
          </label>

          <div className="pv-grid">
            <button type="button" className={`pv-card${isAuto ? " on" : ""}`} onClick={chooseAuto}>
              <ProviderTile mono="Au" color="#2563eb" />
              <span>
                <span className="nm">Eluntra Auto</span>
                <br />
                <span className="st">質問に合わせて自動選択</span>
              </span>
            </button>
            {visibleProviders.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pv-card${!isAuto && conf.provider === p.id ? " on" : ""}`}
                onClick={() => setProviderId(p.id)}
              >
                <ProviderTile mono={p.mono} color={p.color} />
                <span>
                  <span className="nm">{p.name}</span>
                  <br />
                  <span className="st">{keyStateLabel(p.id)}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="set-sec" style={{ marginTop: 4 }}>
            {provider.name} のモデル
            {meta?.fetchedAt ? `（取得：${new Date(meta.fetchedAt).toLocaleString("ja-JP")}）` : ""}
          </div>
          {(provider.modelsNote || meta?.note) && (
            <p className="set-desc">{provider.modelsNote || meta?.note}</p>
          )}
          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <input
              className="search-input"
              placeholder="モデルを検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="モデルを検索"
            />
            <button type="button" className="btn secondary sm" onClick={doFetch} disabled={busy} style={{ flex: "none", alignSelf: "center" }}>
              {busy ? "取得中…" : "一覧を取得"}
            </button>
          </div>

          {recentPairs.length > 0 && !query && (
            <>
              <div className="set-sec">最近使用</div>
              {recentPairs.slice(0, 4).map((r) => (
                <button key={`${r.pid}:${r.model}`} type="button" className="model-row" onClick={() => choose(r.pid, r.model)}>
                  <span className="mid">{r.model}</span>
                  <span style={{ fontSize: 12, color: "var(--text-3)" }}>{findProvider(r.pid).name}</span>
                </button>
              ))}
            </>
          )}

          <div>
            {filtered.map((m) => {
              const selected = !isAuto && conf.provider === providerId && conf.models[providerId] === m;
              const fav = (favorites[providerId] || []).includes(m);
              return (
                <div key={m} className="model-row" style={{ cursor: "pointer" }} onClick={() => choose(providerId, m)}>
                  <span className="mid">{m}</span>
                  <button
                    type="button"
                    className={`star${fav ? " on" : ""}`}
                    aria-label="お気に入り"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleFavorite(providerId, m);
                    }}
                  >
                    <Icon name="star" className="ic sm" />
                  </button>
                  {selected && (
                    <span className="chk">
                      <Icon name="check" className="ic sm" />
                    </span>
                  )}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <p className="set-desc">
                モデルがありません。「一覧を取得」であなたのキーで使えるモデルを読み取るか、下の欄にモデルID（Azureはデプロイ名）を直接入力してください。
              </p>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <input
              className="text-input"
              placeholder="モデルIDを直接入力"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
            />
            <button
              type="button"
              className="btn secondary sm"
              style={{ flex: "none", alignSelf: "center" }}
              onClick={() => {
                if (manual.trim()) choose(providerId, manual.trim());
              }}
            >
              このモデルを使う
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
