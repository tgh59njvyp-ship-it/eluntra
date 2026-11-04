import { PROVIDERS, findProvider } from "./providers";
import type { Config, KeyState, Provider, Session } from "./types";
import { uid } from "./util";

/** localStorageのキー。単一HTML版と接頭辞を共有し、保存データの形式も同一。 */
export const LS = {
  keys: "eluntra_keys",
  tested: "eluntra_tested",
  models: "eluntra_models",
  conf: "eluntra_conf",
  sess: "eluntra_sessions",
  theme: "eluntra_theme",
} as const;

export function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 保存失敗（容量超過など）は致命的でないため無視する */
  }
}

/** アプリ全体の状態（単一オブジェクトに集約） */
export const state = {
  keys: load<Record<string, string>>(LS.keys, {}),
  tested: load<Record<string, boolean>>(LS.tested, {}),
  fetchedModels: load<Record<string, string[]>>(LS.models, {}),
  conf: Object.assign(
    { provider: "gemini", models: {}, system: "", temp: 0.7 } as Config,
    load<Partial<Config>>(LS.conf, {}),
  ),
  sessions: load<Session[]>(LS.sess, []),
  currentId: null as string | null,
};

PROVIDERS.forEach((p) => {
  if (!state.conf.models[p.id]) state.conf.models[p.id] = p.def;
});

/** 生成中フラグと中断用コントローラ */
export const runtime = {
  generating: false,
  abortCtl: null as AbortController | null,
};

export function persistConf(): void {
  save(LS.conf, state.conf);
}
export function persistSessions(): void {
  save(LS.sess, state.sessions);
}
export function persistKeys(): void {
  save(LS.keys, state.keys);
}
export function persistTested(): void {
  save(LS.tested, state.tested);
}
export function persistModels(): void {
  save(LS.models, state.fetchedModels);
}

export function curProv(): Provider {
  return findProvider(state.conf.provider);
}
export function curModel(): string {
  return state.conf.models[state.conf.provider] || curProv().def;
}
export function modelList(pid: string): string[] {
  const fetched = state.fetchedModels[pid];
  return fetched && fetched.length ? fetched : findProvider(pid).models;
}
export function keyState(pid: string): KeyState {
  if (state.tested[pid]) return "ok";
  if (state.keys[pid]) return "set";
  return "none";
}
export function stateLabel(pid: string): string {
  const s = keyState(pid);
  return s === "ok" ? "接続OK" : s === "set" ? "設定済み" : "未設定";
}

/* ---------- セッション操作 ---------- */

export function curSession(): Session | null {
  return state.sessions.find((s) => s.id === state.currentId) ?? null;
}

export function createSession(): Session {
  const s: Session = {
    id: uid(),
    title: "新しいチャット",
    provider: state.conf.provider,
    model: curModel(),
    messages: [],
    created: Date.now(),
  };
  state.sessions.unshift(s);
  state.currentId = s.id;
  persistSessions();
  return s;
}

export function ensureSession(): void {
  if (!curSession()) {
    if (state.sessions.length) state.currentId = state.sessions[0].id;
    else createSession();
  }
}

export function deleteSession(id: string): void {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.currentId === id) {
    state.currentId = state.sessions.length ? state.sessions[0].id : null;
  }
  persistSessions();
}

export function resetAllData(): void {
  [LS.keys, LS.tested, LS.models, LS.conf, LS.sess].forEach((k) =>
    localStorage.removeItem(k),
  );
  state.keys = {};
  state.tested = {};
  state.fetchedModels = {};
  state.sessions = [];
  state.currentId = null;
  state.conf = { provider: "gemini", models: {}, system: "", temp: 0.7 };
  PROVIDERS.forEach((p) => {
    state.conf.models[p.id] = p.def;
  });
}
