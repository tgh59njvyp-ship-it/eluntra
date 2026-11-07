/* Eluntra v6 共通型定義（新規設計）
   保存データの形は旧版と互換：localStorage の JSON 構造をそのまま読み書きする。 */

/** アダプターの種類。openai = OpenAI互換 Chat Completions を使う会社 */
export type AdapterKind =
  | "openai"
  | "gemini"
  | "anthropic"
  | "cohere"
  | "perplexity"
  | "github"
  | "replicate"
  | "bedrock"
  | "azure"
  | "vertex";

/** キー入力欄（複数欄対応） */
export interface KeyFieldDef {
  id: string;
  label: string;
  secret?: boolean;
  placeholder: string;
  hint?: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  /** ロゴ代わりの2文字タイル（公式ロゴ画像は使わず文字＋色で表す） */
  mono: string;
  color: string;
  kind: AdapterKind;
  /** APIベースURL。{account} は Cloudflare の Account ID に置換される */
  base: string;
  keyUrl: string;
  keyHint: string;
  /** 1欄キーでない会社だけ指定。保存時は "::" 区切りでこの順に結合（旧版と同一形式） */
  fields?: KeyFieldDef[];
  /** 初期モデル（実在が確認できるIDのみ。一覧取得で実データに置き換わる） */
  models: string[];
  defaultModel: string;
  /** チャットパスの上書き（Perplexity 等） */
  chatPath?: string;
  /** 一覧取得の扱い: "none" = 一覧APIなし */
  modelsMode?: "standard" | "none" | "catalog" | "deployments" | "foundation" | "tags";
  modelsUrl?: string;
  local?: boolean;
  noKey?: boolean;
  vision?: boolean;
  reasoning?: boolean;
  note?: string;
  modelsNote?: string;
}

export type Role = "user" | "assistant";

export interface Attachment {
  name: string;
  kind: "text" | "image";
  text?: string;
  dataUrl?: string;
  mime?: string;
}

export interface SourceLink {
  title: string;
  url: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  model?: string;
  pending?: boolean;
  steps?: string[];
  sources?: SourceLink[];
  attachments?: Attachment[];
  metaNote?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: ChatMessage[];
  created: number;
  providerAtSend?: string;
  kind?: "chat" | "code";
}

export interface Note {
  id: string;
  title: string;
  content: string;
  created: number;
}

export type Effort = "low" | "medium" | "high" | "super";

export interface AppConfig {
  provider: string;
  models: Record<string, string>;
  system: string;
  temp: number;
  agent: boolean;
  mode: "chat" | "code";
  effort: Effort;
  proxyOn: boolean;
}

export interface ModelMeta {
  fetchedAt?: number;
  note?: string;
}

export interface TestResult {
  ok: boolean;
  msg: string;
}

export type KeyState = "ok" | "set" | "none";
