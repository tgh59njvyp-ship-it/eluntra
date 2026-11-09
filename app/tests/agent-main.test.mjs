/* Eluntra 本体エージェント診断テスト（Node で実行）
   実行: node tests/build-agent-harness.mjs && node tests/agent-main.test.mjs
   実モジュール（store / providers/chat / agent/engine）を使い、fetch だけをスタブする。
   スタブは各社のスキーマ的に正しい応答を返し、リクエストボディを記録して形状を検証する。 */

// ---- ブラウザ環境の最小スタブ（バンドル import 前に必要） ----
const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k),
};
globalThis.window = globalThis;

const realFetch = globalThis.fetch;

let bundle;
try {
  bundle = await import("./.agent-bundle.mjs");
} catch (e) {
  console.error("先に node tests/build-agent-harness.mjs を実行してください", e);
  process.exit(1);
}
const { runAgent, completeChat, getState, update, providerDefOf, UserError, RateLimitError, PROXY_URL, SEARCH_URL } = bundle;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

/* ---------- fetch スタブ ---------- */
const requests = []; // { via, target, body }
let script = []; // モデルの応答テキスト列（呼び出し順に消費）
let scriptIdx = 0;
let failProxyOnce = false; // プロキシ経路を1回だけネットワークエラーにする
let errorOnce = null; // { status, body } を1回だけ返す
let searchMode = "real"; // "real" | "fixed"
let searchUsed = "real";

function nextText() {
  const t = script[Math.min(scriptIdx, script.length - 1)] ?? "（モック応答）";
  scriptIdx++;
  return t;
}

function providerResponse(target) {
  const text = nextText();
  const host = new URL(target).hostname;
  if (host === "generativelanguage.googleapis.com") {
    return { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] };
  }
  if (host === "api.anthropic.com") {
    return { id: "msg_test", type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" };
  }
  if (host === "api.cohere.com") {
    return { id: "cohere-test", message: { role: "assistant", content: [{ type: "text", text }] }, finish_reason: "COMPLETE" };
  }
  // OpenAI互換（groq / openai / openrouter 等）
  return { id: "chatcmpl-test", choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] };
}

function handleTarget(target, body) {
  if (errorOnce) {
    const e = errorOnce;
    errorOnce = null;
    return new Response(JSON.stringify(e.body), { status: e.status, headers: { "Content-Type": "application/json", ...(e.headers || {}) } });
  }
  return new Response(JSON.stringify(providerResponse(target)), { status: 200, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith(SEARCH_URL)) {
    // 検索は本番エンドポイントへ実接続を試み、届かなければ固定ペイロード
    if (searchMode === "real") {
      try {
        return await realFetch(url, opts);
      } catch {
        searchUsed = "fixed";
      }
    } else {
      searchUsed = "fixed";
    }
    return new Response(
      JSON.stringify({ query: "q", results: [{ title: "固定の検索結果", url: "https://example.com/result", snippet: "固定スニペット" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  const headers = new Headers(opts.headers || {});
  const target = headers.get("x-target-url");
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }
  if (target) {
    requests.push({ via: "proxy", target, body });
    if (failProxyOnce) {
      failProxyOnce = false;
      throw new TypeError("fetch failed (stubbed network error)");
    }
    return handleTarget(target, body);
  }
  requests.push({ via: "direct", target: u, body });
  return handleTarget(u, body);
};

/* ---------- 準備 ---------- */
update({
  keys: { groq: "gsk_test", gemini: "AIza_test", anthropic: "sk-ant-test", cohere: "cohere_test", openai: "sk-test" },
});
const GROQ = providerDefOf("groq");
const GEMINI = providerDefOf("gemini");
const ANTHROPIC = providerDefOf("anthropic");
const COHERE = providerDefOf("cohere");
const OPENAI = providerDefOf("openai");
const HISTORY = [{ role: "user", content: "こんにちは、自己紹介して" }];
const noProgress = () => {};

function lastRequestTo(hostPart) {
  return [...requests].reverse().find((r) => r.target.includes(hostPart));
}
function reset(scriptTexts) {
  requests.length = 0;
  script = scriptTexts;
  scriptIdx = 0;
  failProxyOnce = false;
  errorOnce = null;
}

/* ============ A: 通常質問（ツールなし）で全 kind が完走するか ============ */
group("A: 本体エージェント 通常質問（全 kind）");
for (const [label, provider, model, host] of [
  ["openai互換/groq", GROQ, "openai/gpt-oss-120b", "api.groq.com"],
  ["gemini", GEMINI, "gemini-2.5-flash", "generativelanguage.googleapis.com"],
  ["anthropic", ANTHROPIC, "claude-sonnet-4-20250514", "api.anthropic.com"],
  ["cohere", COHERE, "command-a-03-2025", "api.cohere.com"],
]) {
  reset(["最終回答テキストです。"]);
  try {
    const r = await runAgent(provider, model, HISTORY, noProgress);
    ok(r.text === "最終回答テキストです。", `A-${label}: 最終回答が返る`);
  } catch (e) {
    ok(false, `A-${label}: 例外なく完走する（実際: ${e && e.message}）`);
  }
  const req = lastRequestTo(host);
  ok(!!req, `A-${label}: リクエストが記録される`);
  if (req && label.startsWith("anthropic")) {
    const b = req.body || {};
    ok(!(b.thinking && b.temperature !== undefined && b.temperature !== 1),
      "A-anthropic: thinking 有効時に temperature を併記しない（実APIは 400 を返す）");
  }
  if (req && label.startsWith("gemini")) {
    const tc = req.body?.generationConfig?.thinkingConfig;
    console.log(`   gemini thinkingConfig: ${JSON.stringify(tc)}`);
  }
}

/* ============ A2: OpenAI 推論モデル（o4-mini）の temperature ============ */
group("A2: OpenAI 推論モデルのリクエスト形状");
{
  reset(["推論モデルの回答です。"]);
  try {
    const r = await runAgent(OPENAI, "o4-mini", HISTORY, noProgress);
    ok(r.text === "推論モデルの回答です。", "A2-1: o4-mini で完走する");
  } catch (e) {
    ok(false, `A2-1: 例外なく完走する（実際: ${e && e.message}）`);
  }
  const req = lastRequestTo("api.openai.com");
  ok(!!req && req.body && req.body.temperature === undefined,
    "A2-2: 推論モデルには temperature を送らない（実APIは 400 を返す）");
}

/* ============ A3: Gemini の thinkingConfig 形状 ============ */
group("A3: Gemini thinkingConfig（モデル別の妥当性）");
{
  // 2.5 Pro + effort low（thinkingBudget=0 は Pro では不正）
  const conf0 = getState().conf;
  update({ conf: { ...conf0, effort: "low" } });
  reset(["pro の回答です。"]);
  try {
    await runAgent(GEMINI, "gemini-2.5-pro", HISTORY, noProgress);
  } catch { /* 形状検査が目的 */ }
  const reqPro = lastRequestTo("generativelanguage.googleapis.com");
  const tcPro = reqPro?.body?.generationConfig?.thinkingConfig;
  ok(!(tcPro && tcPro.thinkingBudget === 0), `A3-1: gemini-2.5-pro に thinkingBudget=0 を送らない（実際: ${JSON.stringify(tcPro)}）`);
  // Gemini 3 系は thinkingLevel を使う（thinkingBudget は送らない）
  update({ conf: { ...getState().conf, effort: "medium" } });
  reset(["3系の回答です。"]);
  try {
    await runAgent(GEMINI, "gemini-3.5-flash-lite", HISTORY, noProgress);
  } catch { /* 形状検査が目的 */ }
  const req3 = lastRequestTo("generativelanguage.googleapis.com");
  const tc3 = req3?.body?.generationConfig?.thinkingConfig;
  ok(!(tc3 && "thinkingBudget" in tc3), `A3-2: Gemini 3 系に thinkingBudget を送らない（実際: ${JSON.stringify(tc3)}）`);
  update({ conf: conf0 });
}

/* ============ B: ツール呼び出し（web_search → 最終回答）が全 kind で完走するか ============ */
group("B: 本体エージェント ツール経由（web_search）");
const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";
for (const [label, provider, model] of [
  ["groq", GROQ, "openai/gpt-oss-120b"],
  ["gemini", GEMINI, "gemini-2.5-flash"],
  ["anthropic", ANTHROPIC, "claude-sonnet-4-20250514"],
  ["cohere", COHERE, "command-a-03-2025"],
]) {
  reset([toolJson("web_search", { query: "東京の天気" }), "検索結果に基づく最終回答です。"]);
  try {
    const r = await runAgent(provider, model, HISTORY, noProgress);
    ok(r.text === "検索結果に基づく最終回答です。", `B-${label}: ツール後に最終回答が返る`);
    ok(r.sources.length >= 1, `B-${label}: 出典が集まる（${r.sources.length}件）`);
  } catch (e) {
    ok(false, `B-${label}: 例外なく完走する（実際: ${e && e.message}）`);
  }
}
console.log(`   検索経路: ${searchUsed === "real" ? "本番 /api/search へ実接続" : "固定ペイロード（実接続不可のため）"}`);

/* ============ C: 経路フォールバック（プロキシが落ちたら直接で完走） ============ */
group("C: エージェント経路フォールバック");
{
  reset(["フォールバック後の回答です。"]);
  failProxyOnce = true;
  try {
    const r = await runAgent(GROQ, "openai/gpt-oss-120b", HISTORY, noProgress);
    ok(r.text === "フォールバック後の回答です。", "C1: プロキシ失敗後に直接経路で完走する");
  } catch (e) {
    ok(false, `C1: プロキシ失敗後に直接経路で完走する（実際: ${e && e.message}）`);
  }
  ok(requests.some((r) => r.via === "direct" && r.target.includes("api.groq.com")), "C2: 直接経路へのリクエストが実際に飛んだ");
}

/* ============ D: UserError は詳細つきでそのまま伝わる ============ */
group("D: ユーザー側エラー（401）の伝播");
{
  reset(["使われない"]);
  errorOnce = { status: 401, body: { error: { message: "Invalid API Key" } } };
  let caught = null;
  try {
    await runAgent(GROQ, "openai/gpt-oss-120b", HISTORY, noProgress);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof UserError, "D1: 401 は UserError として伝わる");
  ok(!!caught && caught.message.includes("Invalid API Key"), "D2: プロバイダーの詳細（Invalid API Key）が保持される");
  ok(!!caught && caught.message.includes("詳細"), "D3: friendlyError の詳細表記が含まれる");
}

/* ============ E: 429 は RateLimitError（Retry-After つき）になる ============ */
group("E: レート制限エラー（429）の型付け");
{
  reset(["使われない"]);
  errorOnce = { status: 429, headers: { "Retry-After": "30" }, body: { error: { message: "Rate limit exceeded" } } };
  let caught = null;
  try {
    await completeChat(GROQ, "openai/gpt-oss-120b", HISTORY);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof RateLimitError, "E1: 429 は RateLimitError として伝わる");
  ok(caught instanceof UserError, "E2: RateLimitError は UserError の一種（本体の扱いは不変）");
  ok(!!caught && caught.retryAfterMs === 30000, `E3: Retry-After が保持される（実際: ${caught && caught.retryAfterMs}）`);
}

console.log(`\n===== 結果: ${pass} pass / ${fail} fail =====`);
if (failures.length) { console.log("失敗:", failures.join(" / ")); process.exit(1); }
