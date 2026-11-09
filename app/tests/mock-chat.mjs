/* テスト専用スタブ: lib/providers/chat の completeChat / completeWithFallback を差し替える。
   応答は globalThis.__mockLLM(history) が決める（シナリオごとに設定する）。
   __mockLLM が例外を投げれば、そのまま呼び出し側へ伝播する（429 再現用）。 */
export async function completeChat(_provider, _model, history, _signal) {
  const fn = globalThis.__mockLLM;
  if (typeof fn !== "function") throw new Error("mock LLM が設定されていません");
  const text = await fn(history);
  return { text };
}

export async function completeWithFallback(_provider, _model, history, _signal) {
  return completeChat(_provider, _model, history, _signal);
}
