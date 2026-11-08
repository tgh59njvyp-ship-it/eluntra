import { useSyncExternalStore } from "react";
import { PROVIDERS } from "./providers/registry";
import type { AppConfig, ChatSession, CustomEntry, ModelMeta, Note, ProviderDef } from "./types";

/* localStorage のキーと JSON 形式は旧版と同一（引き継ぎ互換のため） */
export const LS = {
  keys: "eluntra_keys",
  tested: "eluntra_tested",
  models: "eluntra_models",
  conf: "eluntra_conf",
  sessions: "eluntra_sessions",
  notes: "eluntra_notes",
  theme: "eluntra_theme",
  modelMeta: "eluntra_model_meta",
  modelFlags: "eluntra_model_flags",
  favorites: "eluntra_favorites",
  recents: "eluntra_recents",
  connectors: "eluntra_connectors",
  connectorAccounts: "eluntra_connector_accounts",
  codes: "eluntra_codes",
  customs: "eluntra_customs",
} as const;

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 容量超過などは致命的でないため無視 */
  }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let customSeq = 0;
/** カスタムプロバイダー用の安定ID（作成後は変わらない） */
export function newCustomId(): string {
  customSeq += 1;
  return `custom-${Date.now().toString(36)}-${customSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type ModelFlag = "free" | "paid";

export interface AppState {
  keys: Record<string, string>;
  tested: Record<string, boolean>;
  fetchedModels: Record<string, string[]>;
  modelMeta: Record<string, ModelMeta>;
  /** プロバイダーID → モデルID → 無料/通常の分類（一覧取得時に価格情報・IDから判定） */
  modelFlags: Record<string, Record<string, ModelFlag>>;
  favorites: Record<string, string[]>;
  recents: string[];
  conf: AppConfig;
  sessions: ChatSession[];
  notes: Note[];
  connectors: Record<string, string>;
  connectorAccounts: Record<string, string>;
  codes: Record<string, string>;
  /** 自分で作るカスタムプロバイダー（キーを含む。ログイン中はアカウント同期の対象） */
  customs: CustomEntry[];
  currentId: string | null;
  theme: "light" | "dark";
}

function defaultConf(): AppConfig {
  return {
    provider: "gemini",
    models: {},
    system: "",
    temp: 0.7,
    agent: false,
    mode: "chat",
    effort: "medium",
    proxyOn: true,
  };
}

function initialState(): AppState {
  const conf: AppConfig = { ...defaultConf(), ...readJSON<Partial<AppConfig>>(LS.conf, {}) };
  PROVIDERS.forEach((p) => {
    if (!conf.models[p.id]) conf.models[p.id] = p.defaultModel;
  });
  let theme: "light" | "dark" = "light";
  try {
    const t = readJSON<unknown>(LS.theme, "light");
    if (t === "dark") theme = "dark";
  } catch {
    theme = "light";
  }
  const keys = readJSON<Record<string, string>>(LS.keys, {});
  const tested = readJSON<Record<string, boolean>>(LS.tested, {});
  const fetchedModels = readJSON<Record<string, string[]>>(LS.models, {});
  const modelFlags = readJSON<Record<string, Record<string, ModelFlag>>>(LS.modelFlags, {});
  let customs = readJSON<CustomEntry[]>(LS.customs, []);
  if (!Array.isArray(customs)) customs = [];
  /* v6.3 の単一「カスタム」（keys["custom"] = "base::key"）を v6.4 のエントリ形式へ移行する */
  if (customs.length === 0 && (keys["custom"] || "").trim()) {
    const parts = (keys["custom"] || "").split("::");
    const base = (parts[0] || "").trim();
    const key = parts.slice(1).join("::").trim();
    if (base || key) {
      const id = newCustomId();
      customs = [{ id, name: "カスタム", base, key }];
      writeJSON(LS.customs, customs);
      if (fetchedModels["custom"]) {
        fetchedModels[id] = fetchedModels["custom"];
        delete fetchedModels["custom"];
        writeJSON(LS.models, fetchedModels);
      }
      if (modelFlags["custom"]) {
        modelFlags[id] = modelFlags["custom"];
        delete modelFlags["custom"];
        writeJSON(LS.modelFlags, modelFlags);
      }
      if (tested["custom"]) {
        tested[id] = tested["custom"];
        delete tested["custom"];
        writeJSON(LS.tested, tested);
      }
      let confChanged = false;
      if (conf.models["custom"]) {
        conf.models[id] = conf.models["custom"];
        delete conf.models["custom"];
        confChanged = true;
      }
      if (conf.provider === "custom") {
        conf.provider = id;
        confChanged = true;
      }
      if (confChanged) writeJSON(LS.conf, conf);
      delete keys["custom"];
      writeJSON(LS.keys, keys);
    }
  }
  return {
    keys,
    tested,
    fetchedModels,
    modelMeta: readJSON(LS.modelMeta, {}),
    modelFlags,
    favorites: readJSON(LS.favorites, {}),
    recents: readJSON(LS.recents, []),
    conf,
    sessions: readJSON(LS.sessions, []),
    notes: readJSON(LS.notes, []),
    connectors: readJSON(LS.connectors, {}),
    connectorAccounts: readJSON(LS.connectorAccounts, {}),
    codes: readJSON(LS.codes, {}),
    customs,
    currentId: null,
    theme,
  };
}

let state: AppState = initialState();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

/* アカウント同期の対象スライス（auth.ts が購読し、ログイン中は自動で push する） */
const SYNCED_SLICES: Array<keyof AppState> = [
  "keys",
  "fetchedModels",
  "modelFlags",
  "favorites",
  "conf",
  "sessions",
  "notes",
  "connectors",
  "connectorAccounts",
  "codes",
  "customs",
  "theme",
];
const dataListeners = new Set<() => void>();

/** 同期対象データが変わったら呼ばれるリスナーを登録する（auth.ts の自動 push 用） */
export function onDataChanged(fn: () => void): () => void {
  dataListeners.add(fn);
  return () => dataListeners.delete(fn);
}

function notifyDataChanged(): void {
  dataListeners.forEach((fn) => fn());
}

/** 状態を部分更新し、関係する localStorage へ保存する */
export function update(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  if (patch.keys) writeJSON(LS.keys, state.keys);
  if (patch.tested) writeJSON(LS.tested, state.tested);
  if (patch.fetchedModels) writeJSON(LS.models, state.fetchedModels);
  if (patch.modelMeta) writeJSON(LS.modelMeta, state.modelMeta);
  if (patch.modelFlags) writeJSON(LS.modelFlags, state.modelFlags);
  if (patch.favorites) writeJSON(LS.favorites, state.favorites);
  if (patch.recents) writeJSON(LS.recents, state.recents);
  if (patch.conf) writeJSON(LS.conf, state.conf);
  if (patch.sessions) writeJSON(LS.sessions, state.sessions);
  if (patch.notes) writeJSON(LS.notes, state.notes);
  if (patch.connectors) writeJSON(LS.connectors, state.connectors);
  if (patch.connectorAccounts) writeJSON(LS.connectorAccounts, state.connectorAccounts);
  if (patch.codes) writeJSON(LS.codes, state.codes);
  if (patch.customs) writeJSON(LS.customs, state.customs);
  if (patch.theme) writeJSON(LS.theme, state.theme);
  emit();
  if (SYNCED_SLICES.some((k) => patch[k] !== undefined)) notifyDataChanged();
}

export function getState(): AppState {
  return state;
}

export function useStore<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => select(state),
  );
}

/* ---------- 実行時（保存しない）フラグ ---------- */
export const runtime = {
  generating: false,
  abortCtl: null as AbortController | null,
};

/* ---------- カスタムプロバイダー（動的プロバイダー定義） ---------- */

export const CUSTOM_MODELS_NOTE =
  "モデルはベースURLの /models から自動取得します。通信はEluntraのサーバー経由で中継するため、CORSを許可していない接続先でも使えます。無料／通常の分類は、接続先が価格情報を返す場合と、モデルIDに :free が付く場合に判定します（判定材料がないモデルは「通常モデル」に入ります）。";

/** カスタムエントリから実行時に使う ProviderDef を合成する */
export function customDef(entry: CustomEntry): ProviderDef {
  const name = (entry.name || "").trim() || "カスタム";
  return {
    id: entry.id,
    name,
    mono: name.slice(0, 2),
    color: "#5B7C99",
    kind: "openai",
    base: entry.base,
    keyUrl: "",
    keyHint: "",
    models: [],
    defaultModel: "",
    vision: true,
    reasoning: true,
    backendProxy: true,
    modelsNote: CUSTOM_MODELS_NOTE,
  };
}

/** 組み込み30社＋自分のカスタムすべて */
export function allProviders(): ProviderDef[] {
  return [...PROVIDERS, ...state.customs.map(customDef)];
}

/** id から ProviderDef を引く（組み込み→カスタムの順）。見つからなければ undefined */
export function providerDefOf(id: string): ProviderDef | undefined {
  const p = PROVIDERS.find((x) => x.id === id);
  if (p) return p;
  const entry = state.customs.find((c) => c.id === id);
  return entry ? customDef(entry) : undefined;
}

/** その id がカスタムプロバイダーか（エントリ実在、または custom- 接頭辞） */
export function isCustomId(id: string): boolean {
  return id.startsWith("custom-") || state.customs.some((c) => c.id === id);
}

export function customEntryOf(id: string): CustomEntry | undefined {
  return state.customs.find((c) => c.id === id);
}

export function keyFieldsOf(pid: string, raw: string): Record<string, string> {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p?.fields?.length) return { key: raw || "" };
  const parts = (raw || "").split("::");
  const out: Record<string, string> = {};
  p.fields.forEach((f, i) => {
    out[f.id] = i === p.fields!.length - 1 ? parts.slice(i).join("::") : parts[i] || "";
  });
  return out;
}

export function joinKeyFields(pid: string, values: Record<string, string>): string {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p?.fields?.length) return (values.key || "").trim();
  return p.fields.map((f) => (values[f.id] || "").trim()).join("::").replace(/(::)+$/, "");
}

/** その会社の実効ベースURL（Cloudflare/ローカル/Azure等の置換を含む） */
export function effectiveBase(pid: string): string {
  const entry = customEntryOf(pid);
  if (entry) return (entry.base || "").trim().replace(/\/+$/, "");
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) return "";
  const vals = keyFieldsOf(pid, state.keys[pid] || "");
  if (pid === "cloudflare") return p.base.replace("{account}", vals.acct || "");
  if (p.local) return (vals.base || "").trim() || p.base;
  if (pid === "azure") return (vals.endpoint || "").trim().replace(/\/$/, "");
  return p.base;
}

/** Bearer 等に使う実トークン */
export function effectiveToken(pid: string): string {
  const entry = customEntryOf(pid);
  if (entry) return entry.key || "";
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) return "";
  const raw = (state.keys[pid] || "").trim();
  if (!p.fields?.length) return raw;
  const vals = keyFieldsOf(pid, raw);
  if (pid === "cloudflare") return vals.token || "";
  if (pid === "azure") return vals.key || "";
  if (pid === "vertex") return vals.token || "";
  if (p.local) return vals.key || "";
  return raw;
}

/** 入力が揃っているか（ローカルは接続テスト成功で判定） */
export function hasCredentials(pid: string): boolean {
  const entry = customEntryOf(pid);
  if (entry) return (entry.base || "").trim().length > 0;
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) return false;
  if (p.noKey) return !!state.tested[pid];
  if (p.fields?.length) {
    const vals = keyFieldsOf(pid, state.keys[pid] || "");
    return p.fields.every((f) => f.optional || (vals[f.id] || "").trim().length > 0);
  }
  return !!(state.keys[pid] || "").trim();
}

export function keyStateOf(pid: string): "ok" | "set" | "none" {
  if (state.tested[pid]) return "ok";
  const entry = customEntryOf(pid);
  if (entry) return (entry.base || "").trim() ? "set" : "none";
  if ((state.keys[pid] || "").trim()) return "set";
  const p = PROVIDERS.find((x) => x.id === pid);
  if (p?.noKey && p.fields?.length) {
    const vals = keyFieldsOf(pid, state.keys[pid] || "");
    if ((vals.base || "").trim()) return "set";
  }
  return "none";
}

export function keyStateLabel(pid: string): string {
  const s = keyStateOf(pid);
  return s === "ok" ? "接続OK" : s === "set" ? "設定済み" : "未設定";
}

export function currentSession(): ChatSession | null {
  return state.sessions.find((s) => s.id === state.currentId) ?? null;
}

export function sessionKindOf(s: ChatSession): "chat" | "code" {
  return s.kind === "code" ? "code" : "chat";
}

export function createSession(): ChatSession {
  const s: ChatSession = {
    id: uid(),
    title: "新しいチャット",
    kind: state.conf.mode,
    provider: state.conf.provider,
    model: selectedModel(state.conf.provider === "auto" ? "gemini" : state.conf.provider),
    messages: [],
    created: Date.now(),
  };
  update({ sessions: [s, ...state.sessions], currentId: s.id });
  return s;
}

export function ensureSession(): ChatSession {
  const cur = currentSession();
  if (cur && sessionKindOf(cur) === state.conf.mode) return cur;
  const same = state.sessions.find((x) => sessionKindOf(x) === state.conf.mode);
  if (same) {
    update({ currentId: same.id });
    return same;
  }
  return createSession();
}

export function selectedModel(pid: string): string {
  const p = providerDefOf(pid);
  if (!p) return "";
  return state.conf.models[pid] || p.defaultModel;
}

export function modelListOf(pid: string): string[] {
  const fetched = state.fetchedModels[pid];
  const p = providerDefOf(pid);
  const base = fetched && fetched.length ? fetched : p?.models || [];
  const favs = state.favorites[pid] || [];
  const rest = base.filter((m) => !favs.includes(m));
  return [...favs.filter((m) => base.includes(m)), ...rest];
}

export function toggleFavorite(pid: string, model: string): void {
  const list = [...(state.favorites[pid] || [])];
  const i = list.indexOf(model);
  if (i >= 0) list.splice(i, 1);
  else list.unshift(model);
  update({ favorites: { ...state.favorites, [pid]: list } });
}

export function pushRecent(pid: string, model: string): void {
  const key = `${pid}:${model}`;
  update({ recents: [key, ...state.recents.filter((r) => r !== key)].slice(0, 8) });
}

export function resetAllData(): void {
  Object.values(LS).forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  });
  ["eluntra_auth", "eluntra_code", "eluntra_guest", "eluntra_last_sync"].forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  });
  state = { ...initialState(), sessions: [], notes: [], keys: {}, tested: {}, customs: [], currentId: null };
  state.conf = defaultConf();
  PROVIDERS.forEach((p) => {
    state.conf.models[p.id] = p.defaultModel;
  });
  emit();
}
