/* 画像生成（v7.0・コンポーザーの「画像を生成」ピル）
   Gemini の画像モデルを優先し、無ければ OpenAI の /images/generations を使う。
   通信は既存の fetchWithTimeout（中継オート）に従い、結果は data URL で返す。 */
import { effectiveToken, providerDefOf } from "./store";
import { fetchWithTimeout, friendlyError, UserError } from "./providers/transport";

export interface GeneratedImage {
  dataUrl: string;
  /** 表示用の生成元ラベル（例: "Google Gemini / gemini-2.5-flash-image"） */
  via: string;
  caption?: string;
}

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const OPENAI_IMAGE_MODEL = "gpt-image-1";

const NEED_KEY_MESSAGE =
  "画像生成には Gemini または OpenAI のAPIキーが必要です。対処：設定 →「APIプロバイダー」で Gemini（Google AI Studioで無料取得できます）または OpenAI のキーを保存してください。";

async function viaGemini(prompt: string, key: string, signal?: AbortSignal): Promise<GeneratedImage> {
  const def = providerDefOf("gemini");
  if (!def) throw new Error("Geminiの定義がありません");
  const url = `${def.base}/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 120000, signal);
  if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), def));
  const j = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> };
    }>;
  };
  const parts = j.candidates?.[0]?.content?.parts || [];
  const img = parts.find((x) => x.inlineData?.data);
  const caption = parts.map((x) => x.text || "").join("").trim() || undefined;
  if (!img?.inlineData?.data) {
    throw new UserError(
      `画像が生成されませんでした。対処：説明を変えてもう一度送ってください。${caption ? `（モデルの応答：${caption.slice(0, 120)}）` : ""}`,
    );
  }
  return {
    dataUrl: `data:${img.inlineData.mimeType || "image/png"};base64,${img.inlineData.data}`,
    via: `Google Gemini / ${GEMINI_IMAGE_MODEL}`,
    caption,
  };
}

async function viaOpenAI(prompt: string, key: string, signal?: AbortSignal): Promise<GeneratedImage> {
  const def = providerDefOf("openai");
  if (!def) throw new Error("OpenAIの定義がありません");
  const res = await fetchWithTimeout(`${def.base}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt, size: "1024x1024" }),
  }, 120000, signal);
  if (!res.ok) throw new UserError(friendlyError(res.status, await res.text(), def));
  const j = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new UserError("画像が生成されませんでした。対処：説明を変えてもう一度送ってください。");
  return { dataUrl: `data:image/png;base64,${b64}`, via: `OpenAI / ${OPENAI_IMAGE_MODEL}` };
}

/** Gemini のキーがあれば Gemini、無ければ OpenAI のキーで生成する。どちらも無ければ UserError */
export async function generateImage(prompt: string, signal?: AbortSignal): Promise<GeneratedImage> {
  const geminiKey = effectiveToken("gemini").trim();
  if (geminiKey) return viaGemini(prompt, geminiKey, signal);
  const openaiKey = effectiveToken("openai").trim();
  if (openaiKey) return viaOpenAI(prompt, openaiKey, signal);
  throw new UserError(NEED_KEY_MESSAGE);
}
