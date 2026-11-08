/* テスト専用スタブ: lib/providers/chat の completeChat を差し替える。
   応答は globalThis.__mockLLM(history) が決める（シナリオごとに設定する）。 */
export async function completeChat(_provider, _model, history, _signal) {
  const fn = globalThis.__mockLLM;
  if (typeof fn !== "function") throw new Error("mock LLM が設定されていません");
  const text = await fn(history);
  return { text };
}
