/* テスト用エントリ: 本体エージェント + 実プロバイダー層を公開する（chat は差し替えない） */
export { runAgent } from "../src/lib/agent/engine";
export { completeChat, completeWithFallback, streamWithFallback } from "../src/lib/providers/chat";
export { UserError, RateLimitError, setRouteOverride, PROXY_URL, SEARCH_URL } from "../src/lib/providers/transport";
export { getState, update, providerDefOf } from "../src/lib/store";
