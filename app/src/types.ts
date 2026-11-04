/** Eluntra 共通型定義 */

export type ProviderType = "openai" | "gemini" | "anthropic" | "cohere";

export interface Provider {
  id: string;
  name: string;
  /** モノグラムタイルに出す2文字 */
  mono: string;
  /** タイルの地色 */
  color: string;
  type: ProviderType;
  /** APIのベースURL */
  base: string;
  /** キー取得ページ */
  getKeyUrl: string;
  /** キー入力欄のヒント */
  keyHint: string;
  /** 標準モデル一覧（キーで実取得するまでの初期値） */
  models: string[];
  /** 既定モデル */
  def: string;
}

export type Role = "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
  model?: string;
  pending?: boolean;
  error?: string;
}

export interface Session {
  id: string;
  title: string;
  provider: string;
  model: string;
  messages: Message[];
  created: number;
  /** 直近の送信に使ったプロバイダー（表示用） */
  providerAtSend?: string;
}

export interface Config {
  provider: string;
  /** プロバイダーID -> 選択中モデル */
  models: Record<string, string>;
  system: string;
  temp: number;
}

export type KeyState = "ok" | "set" | "none";

export interface TestResult {
  ok: boolean;
  msg: string;
}
