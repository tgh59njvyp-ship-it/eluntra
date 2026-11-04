import type { Provider } from "./types";

/** 対応プロバイダー8社の定義。キーは各社のAPIへブラウザから直接送る（BYOK）。 */
export const PROVIDERS: Provider[] = [
  {
    id: "openai", name: "OpenAI", mono: "OA", color: "#191919", type: "openai",
    base: "https://api.openai.com/v1",
    getKeyUrl: "https://platform.openai.com/api-keys", keyHint: "sk-… で始まるキー",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o4-mini"],
    def: "gpt-4o-mini",
  },
  {
    id: "gemini", name: "Google Gemini", mono: "Ge", color: "#1A56DB", type: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    getKeyUrl: "https://aistudio.google.com/apikey", keyHint: "Google AI Studioで無料取得できます",
    models: ["gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash", "gemini-2.0-flash-lite"],
    def: "gemini-3.5-flash-lite",
  },
  {
    id: "anthropic", name: "Anthropic", mono: "An", color: "#B45A2D", type: "anthropic",
    base: "https://api.anthropic.com/v1",
    getKeyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-… で始まるキー",
    models: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-20250224", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    def: "claude-sonnet-4-20250514",
  },
  {
    id: "mistral", name: "Mistral AI", mono: "Mi", color: "#E85D04", type: "openai",
    base: "https://api.mistral.ai/v1",
    getKeyUrl: "https://console.mistral.ai/api-keys", keyHint: "MistralコンソールのAPIキー",
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest", "open-mistral-nemo", "codestral-latest"],
    def: "mistral-small-latest",
  },
  {
    id: "groq", name: "Groq", mono: "Gr", color: "#3A3A3A", type: "openai",
    base: "https://api.groq.com/openai/v1",
    getKeyUrl: "https://console.groq.com/keys", keyHint: "gsk_… で始まるキー（無料枠あり）",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "qwen-qwq-32b", "deepseek-r1-distill-llama-70b", "gemma2-9b-it"],
    def: "llama-3.3-70b-versatile",
  },
  {
    id: "openrouter", name: "OpenRouter", mono: "OR", color: "#5B4BC4", type: "openai",
    base: "https://openrouter.ai/api/v1",
    getKeyUrl: "https://openrouter.ai/settings/keys", keyHint: "sk-or-… で始まるキー（無料モデルあり）",
    models: ["openai/gpt-4o-mini", "anthropic/claude-3.5-sonnet", "google/gemini-2.0-flash-001", "meta-llama/llama-3.3-70b-instruct", "deepseek/deepseek-chat", "qwen/qwen-2.5-72b-instruct"],
    def: "openai/gpt-4o-mini",
  },
  {
    id: "cohere", name: "Cohere", mono: "Co", color: "#0F4C3A", type: "cohere",
    base: "https://api.cohere.com",
    getKeyUrl: "https://dashboard.cohere.com/api-keys", keyHint: "Cohereダッシュボードのキー（試用キーあり）",
    models: ["command-a-03-2025", "command-r7b-12-2024", "command-r-plus-08-2024", "command-r-08-2024"],
    def: "command-a-03-2025",
  },
  {
    id: "deepseek", name: "DeepSeek", mono: "De", color: "#2B4BFF", type: "openai",
    base: "https://api.deepseek.com/v1",
    getKeyUrl: "https://platform.deepseek.com/api_keys", keyHint: "sk-… で始まるキー",
    models: ["deepseek-chat", "deepseek-reasoner"],
    def: "deepseek-chat",
  },
];

export function findProvider(id: string): Provider {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`未知のプロバイダー: ${id}`);
  return p;
}
