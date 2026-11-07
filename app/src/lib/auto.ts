import { PROVIDERS } from "./providers/registry";
import { getState, hasCredentials, selectedModel } from "./store";
import type { ProviderDef } from "./types";

/* Eluntra Auto：質問を分類し、接続済みの会社・モデルをスコアリングして選ぶ。
   特定のモデルには依存せず、未接続・利用不可のものは候補に入れない。 */

const PRIORITY = [
  "gemini", "groq", "cerebras", "openai", "openrouter", "mistral", "deepseek",
  "anthropic", "cohere", "cloudflare", "sambanova", "xai", "together", "fireworks",
  "nvidia", "novita", "hyperbolic", "siliconflow", "perplexity", "huggingface",
  "githubmodels", "ai21", "replicate", "bedrock", "azure", "vertex", "alephalpha",
  "ollama", "lmstudio", "llamacpp",
];

export type QuestionKind = "code" | "math" | "image" | "long" | "simple" | "general";

export function classifyQuestion(text: string, hasImage: boolean): QuestionKind {
  if (hasImage) return "image";
  const t = text || "";
  if (/(コード|プログラム|関数|バグ|実装|エラー|python|javascript|typescript|html|css|sql|api|スクリプト|アプリを作|サイトを作)/i.test(t)) return "code";
  if (/(計算|数学|方程式|証明|論理|確率|微分|積分|解いて)/.test(t)) return "math";
  if (t.length > 1800) return "long";
  if (t.trim().length <= 30) return "simple";
  return "general";
}

const FAST_RE = /(flash|mini|haiku|instant|8b|nano|lite|small|turbo)/i;
const CODE_RE = /(codestral|deepseek|qwen|coder|gpt-4|claude)/i;
const REASON_RE = /(reasoner|deepseek-r1|\bo\d|gpt-5|sonnet|pro\b|opus|grok-4)/i;

const skip = new Set<string>();
export function skipAutoProviders(ids: string[]): void {
  ids.forEach((id) => skip.add(id));
}
export function clearAutoSkip(): void {
  skip.clear();
}

export interface AutoChoice {
  provider: ProviderDef;
  model: string;
  reason: string;
}

export function resolveAuto(text = "", opts: { hasImage?: boolean } = {}): AutoChoice | null {
  const st = getState();
  const kind = classifyQuestion(text, !!opts.hasImage);
  const cands = PROVIDERS.filter(
    (p) => hasCredentials(p.id) && !skip.has(p.id) && !p.local && (p.id !== "sambanova" || st.conf.proxyOn !== false),
  );
  if (!cands.length) return null;
  const scored = cands
    .map((p) => {
      const model = selectedModel(p.id);
      let score = 1000 - PRIORITY.indexOf(p.id) * 4;
      if (st.tested[p.id]) score += 120;
      if (kind === "image") score += p.vision ? 200 : -500;
      if (kind === "code") {
        if (CODE_RE.test(model)) score += 90;
        if (p.id === "deepseek" || p.id === "mistral") score += 30;
      }
      if (kind === "math" && (REASON_RE.test(model) || p.reasoning)) score += 90;
      if (kind === "simple") {
        if (FAST_RE.test(model)) score += 90;
        if (p.id === "cerebras" || p.id === "groq") score += 40;
      }
      if (kind === "long" && (p.id === "gemini" || p.id === "anthropic" || p.id === "openai")) score += 80;
      if ((st.conf.effort === "high" || st.conf.effort === "super") && (REASON_RE.test(model) || p.reasoning)) score += 50;
      if (st.conf.effort === "low" && FAST_RE.test(model)) score += 50;
      return { p, model, score };
    })
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  const reasons: Record<QuestionKind, string> = {
    code: "コード向けのモデルを選びました",
    math: "推論が得意なモデルを選びました",
    image: "画像に対応するモデルを選びました",
    long: "長文に対応しやすいモデルを選びました",
    simple: "短い質問なので高速なモデルを選びました",
    general: "接続テストの状態と優先順位から選びました",
  };
  return { provider: top.p, model: top.model, reason: `${reasons[kind]}（${top.p.name} / ${top.model}）` };
}
