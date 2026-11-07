/** Eluntra 共通型定義（v5.0：30社対応） */

export type ProviderType =
  | "openai" | "gemini" | "anthropic" | "cohere"
  | "replicate" | "bedrock" | "azure" | "vertex";

/** 複数欄のキー入力（Cloudflare / Azure / Bedrock / Vertex / ローカルのベースURL変更など） */
export interface KeyField {
  id: string;
  label: string;
  /** パスワード欄にするか */
  secret?: boolean;
  placeholder: string;
  /** その欄だけの補足 */
  hint?: string;
}

/** 確認できている範囲の能力ヒント（不明なものは付けない） */
export interface ProviderCaps {
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
}

export interface Provider {
  id: string;
  name: string;
  mono: string;
  color: string;
  type: ProviderType;
  base: string;
  getKeyUrl: string;
  keyHint: string;
  models: string[];
  /** 旧形式互換：2欄キー（Cloudflare） */
  dualKey?: boolean;
  /** 汎用複数欄入力。指定時は保存形式 "::" 区切りでこの順に結合する */
  keyFields?: KeyField[];
  def: string;
  /** チャットパスの上書き（既定は type ごとの標準パス） */
  chatPath?: string;
  /** モデル一覧パス。"none" の会社は一覧APIが無いことを表す */
  modelsPath?: string;
  /** モデル一覧が別URLの会社（GitHub Modelsのカタログ等） */
  modelsUrl?: string;
  /** ローカルAI（中継を経由せず常に直接接続） */
  local?: boolean;
  /** キー不要で接続できる会社（ローカルAI） */
  noKey?: boolean;
  caps?: ProviderCaps;
  /** モデル一覧まわりの正直な注記（一覧APIなし等） */
  modelsNote?: string;
  /** 設定画面に出す方式差の注記 */
  note?: string;
}

export type Role = "user" | "assistant";

export interface Attachment {
  name: string;
  kind: "text" | "image";
  /** テキストファイルの内容 */
  text?: string;
  /** 画像の data URL（base64） */
  dataUrl?: string;
  mime?: string;
}

export interface SourceLink {
  title: string;
  url: string;
}

export interface Message {
  role: Role;
  content: string;
  model?: string;
  pending?: boolean;
  error?: string;
  steps?: string[];
  /** エージェント／Perplexityが使った出典 */
  sources?: SourceLink[];
  /** 添付ファイル（表示用＋送信時に使う） */
  attachments?: Attachment[];
  /** Eluntra Autoの選択理由など、回答に添える小さな注記 */
  metaNote?: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  created: number;
}

export interface Session {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: Message[];
  created: number;
  providerAtSend?: string;
  kind?: "chat" | "code";
}

export interface Config {
  provider: string;
  models: Record<string, string>;
  system: string;
  temp: number;
  agent: boolean;
  mode: "chat" | "code";
  effort: "low" | "medium" | "high" | "super";
  proxyOn: boolean;
}

export type KeyState = "ok" | "set" | "none";

export interface TestResult {
  ok: boolean;
  msg: string;
}

/** モデル一覧の取得メタ情報 */
export interface ModelMeta {
  fetchedAt?: number;
  note?: string;
}
