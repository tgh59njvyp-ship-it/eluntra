import { useSyncExternalStore } from "react";
import { PROVIDERS } from "./providers/registry";
import type { AppConfig, ChatSession, ModelMeta, Note } from "./types";

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
  favorites: "eluntra_favorites",
  recents: "eluntra_recents",
  connectors: "eluntra_connectors",
  codes: "eluntra_codes",
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

export interface AppState {
  keys: Record<string, string>;
  tested: Record<string, boolean>;
  fetchedModels: Record<string, string[]>;
  modelMeta: Record<string, ModelMeta>;
  favorites: Record<string, string[]>;
  recents: string[];
  conf: AppConfig;
  sessions: ChatSession[];
  notes: Note[];
  connectors: Record<string, string>;
  codes: Record<string, string>;
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
  return {
    keys: readJSON(LS.keys, {}),
    tested: readJSON(LS.tested, {}),
    fetchedModels: readJSON(LS.models, {}),
    modelMeta: readJSON(LS.modelMeta, {}),
    favorites: readJSON(LS.favorites, {}),
    recents: readJSON(LS.recents, []),
    conf,
    sessions: readJSON(LS.sessions, []),
    notes: readJSON(LS.notes, []),
    connectors: readJSON(LS.connectors, {}),
    codes: readJSON(LS.codes, {}),
    currentId: null,
    theme,
  };
}

let state: AppState = initialState();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((fn) => fn());
}

/** 状態を部分更新し、関係する localStorage へ保存する */
export function update(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  if (patch.keys) writeJSON(LS.keys, state.keys);
  if (patch.tested) writeJSON(LS.tested, state.tested);
  if (patch.fetchedModels) writeJSON(LS.models, state.fetchedModels);
  if (patch.modelMeta) writeJSON(LS.modelMeta, state.modelMeta);
  if (patch.favorites) writeJSON(LS.favorites, state.favorites);
  if (patch.recents) writeJSON(LS.recents, state.recents);
  if (patch.conf) writeJSON(LS.conf, state.conf);
  if (patch.sessions) writeJSON(LS.sessions, state.sessions);
  if (patch.notes) writeJSON(LS.notes, state.notes);
  if (patch.connectors) writeJSON(LS.connectors, state.connectors);
  if (patch.codes) writeJSON(LS.codes, state.codes);
  if (patch.theme) writeJSON(LS.theme, state.theme);
  emit();
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

/* ---------- キーの複数欄ヘルパー（保存形式は旧版と同じ "::" 区切り） ---------- */

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
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) return false;
  if (p.noKey) return !!state.tested[pid];
  if (p.fields?.length) {
    const vals = keyFieldsOf(pid, state.keys[pid] || "");
    return p.fields.every((f) => (vals[f.id] || "").trim().length > 0);
  }
  return !!(state.keys[pid] || "").trim();
}

export function keyStateOf(pid: string): "ok" | "set" | "none" {
  if (state.tested[pid]) return "ok";
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
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) return "";
  return state.conf.models[pid] || p.defaultModel;
}

export function modelListOf(pid: string): string[] {
  const fetched = state.fetchedModels[pid];
  const p = PROVIDERS.find((x) => x.id === pid);
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
  state = { ...initialState(), sessions: [], notes: [], keys: {}, tested: {}, currentId: null };
  state.conf = defaultConf();
  PROVIDERS.forEach((p) => {
    state.conf.models[p.id] = p.defaultModel;
  });
  emit();
}
