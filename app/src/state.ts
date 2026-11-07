import { PROVIDERS, findProvider } from "./providers";
import type { Config, KeyState, Note, Provider, Session } from "./types";
import { uid } from "./util";

/** localStorageのキー。単一HTML版と接頭辞を共有し、保存データの形式も同一。 */
export const LS = {
  keys: "eluntra_keys",
  tested: "eluntra_tested",
  models: "eluntra_models",
  conf: "eluntra_conf",
  sess: "eluntra_sessions",
  notes: "eluntra_notes",
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
    { provider: "gemini", models: {}, system: "", temp: 0.7, agent: false, mode: "chat", effort: "medium" } as Config,
    load<Partial<Config>>(LS.conf, {}),
  ),
  sessions: load<Session[]>(LS.sess, []),
  notes: load<Note[]>(LS.notes, []),
  currentId: null as string | null,
};

PROVIDERS.forEach((p) => {
  if (!state.conf.models[p.id]) state.conf.models[p.id] = p.def;
});

/** コードモードの保存キー（auth.tsの同期でも使う） */
export const CODE_LS_KEY = "eluntra_code";

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
export function persistNotes(): void {
  save(LS.notes, state.notes);
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

/** 会話の種類（未指定はチャット扱い） */
export function sessionKind(s: Session): "chat" | "code" {
  return s.kind === "code" ? "code" : "chat";
}

export function createSession(): Session {
  const s: Session = {
    id: uid(),
    title: "新しいチャット",
    kind: state.conf.mode,
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
  const cur = curSession();
  if (cur && sessionKind(cur) === state.conf.mode) return;
  const same = state.sessions.find((x) => sessionKind(x) === state.conf.mode);
  if (same) state.currentId = same.id;
  else if (!cur) createSession();
  else state.currentId = null;
}

export function deleteSession(id: string): void {
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.currentId === id) {
    const same = state.sessions.find((x) => sessionKind(x) === state.conf.mode);
    state.currentId = same ? same.id : null;
  }
  persistSessions();
}

export function resetAllData(): void {
  [LS.keys, LS.tested, LS.models, LS.conf, LS.sess, LS.notes].forEach((k) =>
    localStorage.removeItem(k),
  );
  state.keys = {};
  state.tested = {};
  state.fetchedModels = {};
  state.sessions = [];
  state.notes = [];
  state.currentId = null;
  state.conf = { provider: "gemini", models: {}, system: "", temp: 0.7, agent: false, mode: "chat", effort: "medium" };
  PROVIDERS.forEach((p) => {
    state.conf.models[p.id] = p.def;
  });
}

/** Cloudflareなど2要素キーの分割・結合（保存形式は "AccountID::トークン"） */
export function splitSavedKey(pid: string, raw: string): { acct: string; token: string } {
  if (pid !== "cloudflare") return { acct: "", token: raw || "" };
  const i = (raw || "").indexOf("::");
  if (i < 0) return { acct: "", token: raw || "" };
  return { acct: raw.slice(0, i), token: raw.slice(i + 2) };
}
export function joinSavedKey(pid: string, acct: string, token: string): string {
  if (pid !== "cloudflare") return token;
  return acct && token ? `${acct}::${token}` : token || acct;
}
