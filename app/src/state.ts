import { PROVIDERS, findProvider } from "./providers";
import type { Config, KeyState, ModelMeta, Note, Provider, Session } from "./types";
import { uid } from "./util";

export const LS = {
  keys: "eluntra_keys",
  tested: "eluntra_tested",
  models: "eluntra_models",
  conf: "eluntra_conf",
  sess: "eluntra_sessions",
  notes: "eluntra_notes",
  theme: "eluntra_theme",
  modelMeta: "eluntra_model_meta",
  favorites: "eluntra_favorites",
  recents: "eluntra_recents",
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
    /* 保存失敗は致命的でないため無視する */
  }
}

export const state = {
  keys: load<Record<string, string>>(LS.keys, {}),
  tested: load<Record<string, boolean>>(LS.tested, {}),
  fetchedModels: load<Record<string, string[]>>(LS.models, {}),
  modelMeta: load<Record<string, ModelMeta>>(LS.modelMeta, {}),
  favorites: load<Record<string, string[]>>(LS.favorites, {}),
  recents: load<string[]>(LS.recents, []),
  conf: Object.assign(
    { provider: "gemini", models: {}, system: "", temp: 0.7, agent: false, mode: "chat", effort: "medium", proxyOn: true } as Config,
    load<Partial<Config>>(LS.conf, {}),
  ),
  sessions: load<Session[]>(LS.sess, []),
  notes: load<Note[]>(LS.notes, []),
  currentId: null as string | null,
};

PROVIDERS.forEach((p) => {
  if (!state.conf.models[p.id]) state.conf.models[p.id] = p.def;
});

export const CODE_LS_KEY = "eluntra_code";

export const runtime = {
  generating: false,
  abortCtl: null as AbortController | null,
};

export function persistConf(): void { save(LS.conf, state.conf); }
export function persistSessions(): void { save(LS.sess, state.sessions); }
export function persistKeys(): void { save(LS.keys, state.keys); }
export function persistTested(): void { save(LS.tested, state.tested); }
export function persistNotes(): void { save(LS.notes, state.notes); }
export function persistModels(): void { save(LS.models, state.fetchedModels); }
export function persistModelMeta(): void { save(LS.modelMeta, state.modelMeta); }
export function persistFavorites(): void { save(LS.favorites, state.favorites); }
export function persistRecents(): void { save(LS.recents, state.recents); }

/* ---------- キーの複数欄（keyFields）汎用処理 ----------
   保存形式は従来どおり "::" 区切りで、keyFields の順に結合する。
   Cloudflare の既存保存形式 "AccountID::トークン" とそのまま互換。 */

export function getKeyFields(pid: string): Record<string, string> {
  const p = PROVIDERS.find((x) => x.id === pid);
  const raw = state.keys[pid] || "";
  if (!p || !p.keyFields || !p.keyFields.length) return { key: raw };
  const parts = raw.split("::");
  const out: Record<string, string> = {};
  p.keyFields.forEach((f, i) => {
    // 最後の欄は "::" を含みうる値（URL等ではないが安全側）として残りを結合…ただし従来互換のため単純割当を基本にし、余りは最後の欄へ
    out[f.id] = i === p.keyFields!.length - 1 ? parts.slice(i).join("::") : (parts[i] || "");
  });
  return out;
}

export function joinKeyFields(pid: string, values: Record<string, string>): string {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p || !p.keyFields || !p.keyFields.length) return values.key || "";
  return p.keyFields.map((f) => (values[f.id] || "").trim()).join("::").replace(/(::)+$/, "");
}

/** 旧API互換：{acct, token}（Cloudflareの2欄と、単一キーの token のみ） */
export function splitSavedKey(pid: string, raw: string): { acct: string; token: string } {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (p?.keyFields && p.keyFields.length >= 2) {
    const parts = (raw || "").split("::");
    return { acct: parts[0] || "", token: parts.slice(1).join("::") };
  }
  if (pid === "cloudflare") {
    const i = (raw || "").indexOf("::");
    if (i < 0) return { acct: "", token: raw || "" };
    return { acct: raw.slice(0, i), token: raw.slice(i + 2) };
  }
  return { acct: "", token: raw || "" };
}
export function joinSavedKey(pid: string, acct: string, token: string): string {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (p?.keyFields && p.keyFields.length >= 2) {
    const values: Record<string, string> = {};
    values[p.keyFields[0].id] = acct;
    values[p.keyFields[1].id] = token;
    // 3欄以上の会社では joinSavedKey は使わない（getKeyFields/joinKeyFieldsを使う）
    return joinKeyFields(pid, { ...getKeyFields(pid), ...values });
  }
  if (pid !== "cloudflare") return token;
  return acct && token ? `${acct}::${token}` : token || acct;
}

/** その会社が「使える状態の入力」を持っているか（キー不要の会社はテストOK時のみ候補） */
export function hasCredentials(pid: string): boolean {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (!p) return false;
  if (p.noKey) return !!state.tested[pid];
  if (p.keyFields && p.keyFields.length) {
    const v = getKeyFields(pid);
    // ローカルはベースURL欄のみ＝常に入力ありとみなすが、候補化は tested で判断する
    return p.keyFields.every((f) => (v[f.id] || "").trim().length > 0);
  }
  return !!(state.keys[pid] || "").trim();
}

/* ---------- Eluntra Auto ---------- */

const AUTO_PRIORITY = [
  "gemini", "groq", "cerebras", "openai", "openrouter", "mistral", "deepseek",
  "anthropic", "cohere", "cloudflare", "sambanova", "xai", "together", "fireworks",
  "nvidia", "novita", "hyperbolic", "siliconflow", "perplexity", "huggingface",
  "githubmodels", "ai21", "replicate", "bedrock", "azure", "vertex", "alephalpha",
  "ollama", "lmstudio", "llamacpp",
];

export function isAuto(): boolean {
  return state.conf.provider === "auto";
}

const autoSkip = new Set<string>();
export function skipAutoProviders(ids: string[]): void {
  ids.forEach((id) => autoSkip.add(id));
}
export function clearAutoSkip(): void {
  autoSkip.clear();
}

export type AutoKind = "code" | "math" | "image" | "long" | "simple" | "general";

export function classifyQuestion(text: string, hasImage: boolean): AutoKind {
  if (hasImage) return "image";
  const t = text || "";
  if (/(コード|プログラム|関数|バグ|実装|エラー|python|javascript|typescript|html|css|sql|api|スクリプト|アプリを作|サイトを作)/i.test(t)) return "code";
  if (/(計算|数学|方程式|証明|論理|確率|微分|積分|解いて|なぜ.*成り立)/.test(t)) return "math";
  if (t.length > 1800) return "long";
  if (t.trim().length <= 30) return "simple";
  return "general";
}

const FAST_RE = /(flash|mini|haiku|instant|8b|nano|lite|small|turbo)/i;
const CODE_RE = /(codestral|deepseek|qwen|coder|gpt-4|claude)/i;
const REASON_RE = /(reasoner|deepseek-r1|\bo\d|gpt-5|sonnet|pro\b|opus|grok-4)/i;

/**
 * Eluntra Auto（高度化）：質問を分類し、接続済みモデルをスコアリングして
 * 選んだ理由の文字列と一緒に返す。実在しない／未接続のものは候補にしない。
 */
export function resolveAutoWithReason(
  text = "",
  opts: { hasImage?: boolean } = {},
): { provider: Provider; model: string; reason: string } | null {
  const kind = classifyQuestion(text, !!opts.hasImage);
  const cands = PROVIDERS.filter(
    (p) =>
      hasCredentials(p.id) &&
      !autoSkip.has(p.id) &&
      (p.id !== "sambanova" || state.conf.proxyOn !== false) &&
      !p.local,
  );
  if (!cands.length) return null;
  const scored = cands.map((p) => {
    const model = state.conf.models[p.id] || p.def;
    let score = 1000 - AUTO_PRIORITY.indexOf(p.id) * 4;
    if (state.tested[p.id]) score += 120;
    if (kind === "image") {
      if (p.caps?.vision) score += 200; else score -= 500;
    }
    if (kind === "code") {
      if (CODE_RE.test(model)) score += 90;
      if (p.id === "deepseek" || p.id === "mistral") score += 30;
    }
    if (kind === "math") {
      if (REASON_RE.test(model) || p.caps?.reasoning) score += 90;
    }
    if (kind === "simple") {
      if (FAST_RE.test(model)) score += 90;
      if (p.id === "cerebras" || p.id === "groq") score += 40;
    }
    if (kind === "long") {
      if (p.id === "gemini" || p.id === "anthropic" || p.id === "openai") score += 80;
    }
    if (state.conf.effort === "high" || state.conf.effort === "super") {
      if (REASON_RE.test(model) || p.caps?.reasoning) score += 50;
    }
    if (state.conf.effort === "low" && FAST_RE.test(model)) score += 50;
    return { p, model, score };
  }).sort((a, b) => b.score - a.score);
  const top = scored[0];
  const reasonMap: Record<AutoKind, string> = {
    code: "コード向けのモデルを選びました",
    math: "推論が得意なモデルを選びました",
    image: "画像に対応するモデルを選びました",
    long: "長文に対応しやすいモデルを選びました",
    simple: "短い質問なので高速なモデルを選びました",
    general: "接続テストの状態と優先順位から選びました",
  };
  return { provider: top.p, model: top.model, reason: `${reasonMap[kind]}（${top.p.name} / ${top.model}）` };
}

export function resolveAuto(): Provider | null {
  return resolveAutoWithReason("")?.provider ?? null;
}

export function curProv(): Provider {
  if (isAuto()) return resolveAuto() ?? findProvider("gemini");
  return findProvider(state.conf.provider);
}
export function curModel(): string {
  const p = curProv();
  return state.conf.models[p.id] || p.def;
}
export function modelList(pid: string): string[] {
  const fetched = state.fetchedModels[pid];
  return fetched && fetched.length ? fetched : findProvider(pid).models;
}
export function keyState(pid: string): KeyState {
  const p = PROVIDERS.find((x) => x.id === pid);
  if (state.tested[pid]) return "ok";
  if (p?.noKey) return "set";
  if (p?.keyFields && p.keyFields.length) {
    return hasCredentials(pid) ? "set" : (state.keys[pid] ? "set" : "none");
  }
  if (state.keys[pid]) return "set";
  return "none";
}
export function stateLabel(pid: string): string {
  const s = keyState(pid);
  return s === "ok" ? "接続OK" : s === "set" ? "設定済み" : "未設定";
}

/* ---------- お気に入り・最近使用 ---------- */

export function isFavorite(pid: string, model: string): boolean {
  return (state.favorites[pid] || []).includes(model);
}
export function toggleFavorite(pid: string, model: string): boolean {
  const list = [...(state.favorites[pid] || [])];
  const i = list.indexOf(model);
  if (i >= 0) list.splice(i, 1); else list.unshift(model);
  state.favorites[pid] = list;
  persistFavorites();
  return i < 0;
}
export function pushRecent(pid: string, model: string): void {
  const key = `${pid}:${model}`;
  state.recents = [key, ...state.recents.filter((r) => r !== key)].slice(0, 8);
  persistRecents();
}

/* ---------- セッション操作 ---------- */

export function curSession(): Session | null {
  return state.sessions.find((s) => s.id === state.currentId) ?? null;
}

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
  [LS.keys, LS.tested, LS.models, LS.conf, LS.sess, LS.notes, LS.modelMeta, LS.favorites, LS.recents].forEach((k) =>
    localStorage.removeItem(k),
  );
  try { localStorage.removeItem("eluntra_connectors"); } catch { /* ignore */ }
  state.keys = {};
  state.tested = {};
  state.fetchedModels = {};
  state.modelMeta = {};
  state.favorites = {};
  state.recents = [];
  state.sessions = [];
  state.notes = [];
  state.currentId = null;
  state.conf = { provider: "gemini", models: {}, system: "", temp: 0.7, agent: false, mode: "chat", effort: "medium", proxyOn: true };
  PROVIDERS.forEach((p) => {
    state.conf.models[p.id] = p.def;
  });
}
