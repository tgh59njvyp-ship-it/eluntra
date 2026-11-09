/* Eluntra エージェント: Supabaseプロジェクト作成テスト（Node で実行）
   実行: node tests/build-agent-harness.mjs && node tests/supabase-create.test.mjs
   実モジュール（store / connectors/supabase / agent/engine）を使い、fetch だけをスタブする。
   Management API（api.supabase.com）へのリクエストはスタブが状態を持って応答し、
   作成→ポーリング→キー取得→コネクタ保存までの一連を検証する。 */

// ---- ブラウザ環境の最小スタブ（バンドル import 前に必要） ----
const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k),
};
globalThis.window = globalThis;

/* ポーリングをテスト用に短縮（本番は10秒間隔・最大120秒） */
globalThis.__ELUNTRA_SB_POLL_MS = 5;
globalThis.__ELUNTRA_SB_POLL_TIMEOUT_MS = 120_000;

let bundle;
try {
  bundle = await import("./.agent-bundle.mjs");
} catch (e) {
  console.error("先に node tests/build-agent-harness.mjs を実行してください", e);
  process.exit(1);
}
const {
  runAgent, getState, update, providerDefOf,
  supabaseOrgs, supabaseCreateProjectTool, supabaseProjectSetupTool,
} = bundle;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

/* ---------- Supabase Management API スタブ ---------- */
const REF = "abcdefghijklmnopqrst"; // 20文字のref
const SERVICE_KEY = "service_role_key_stubbed";
let sb = null; // シナリオごとの状態
let mgmtCalls = []; // api.supabase.com への呼び出し記録 {method, path, body}

function freshSb(overrides = {}) {
  sb = {
    orgs: [{ id: "org-1", name: "My Org" }],
    createError: null, // { status, body }
    statusQueue: ["ACTIVE_HEALTHY"], // GET /projects/{ref} が返す status（順に消費、最後を繰り返す）
    createBody: null,
    ...overrides,
  };
  mgmtCalls = [];
}

function mgmtResponse(method, path, body) {
  mgmtCalls.push({ method, path, body });
  if (method === "GET" && path === "/v1/organizations") {
    return new Response(JSON.stringify(sb.orgs), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (method === "POST" && path === "/v1/projects") {
    if (sb.createError) {
      return new Response(JSON.stringify(sb.createError.body), {
        status: sb.createError.status, headers: { "Content-Type": "application/json" },
      });
    }
    sb.createBody = body;
    return new Response(JSON.stringify({
      id: REF, ref: REF, organization_id: body.organization_id,
      name: body.name, region: body.region, status: "COMING_UP",
    }), { status: 201, headers: { "Content-Type": "application/json" } });
  }
  if (method === "GET" && path === `/v1/projects/${REF}`) {
    const status = sb.statusQueue.length > 1 ? sb.statusQueue.shift() : sb.statusQueue[0];
    return new Response(JSON.stringify({
      id: REF, ref: REF, name: sb.createBody?.name || "proj", region: "ap-northeast-1", status,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (method === "GET" && path.startsWith(`/v1/projects/${REF}/api-keys`)) {
    return new Response(JSON.stringify([
      { name: "anon", api_key: "anon_key_stubbed" },
      { name: "service_role", api_key: SERVICE_KEY },
    ]), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ message: `unstubbed: ${method} ${path}` }), { status: 404 });
}

/* ---------- LLM（groq）スタブ ---------- */
let script = [];
let scriptIdx = 0;
const llmBodies = [];
function nextText() {
  const t = script[Math.min(scriptIdx, script.length - 1)] ?? "（モック応答）";
  scriptIdx++;
  return t;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || "GET").toUpperCase();
  const headers = new Headers(opts.headers || {});
  const target = headers.get("x-target-url");
  let body = null;
  try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = null; }

  /* Supabase Management API（直接 or 中継経由の再試行） */
  const sbUrl = u.includes("api.supabase.com") ? u : (target && target.includes("api.supabase.com") ? target : null);
  if (sbUrl) {
    const path = new URL(sbUrl).pathname + (new URL(sbUrl).search || "");
    return mgmtResponse(method, path.replace(/^\/v1/, "/v1"), body);
  }
  /* LLM（プロキシ経由: x-target-url / 直接） */
  const llmTarget = target || u;
  if (llmTarget.includes("api.groq.com")) {
    llmBodies.push(body);
    const text = nextText();
    return new Response(JSON.stringify({
      id: "chatcmpl-test",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ message: `unstubbed fetch: ${u}` }), { status: 404 });
};

const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";
const GROQ = providerDefOf("groq");
const noProgress = () => {};

function seedSbp() {
  update({ connectors: { supabase: JSON.stringify({ url: "", serviceKey: "", sbp: "sbp_test_token" }) } });
}
function savedCreds() {
  const raw = getState().connectors["supabase"] || "";
  try { return JSON.parse(raw); } catch { return null; }
}

/* ============ F: 組織が1つ → 作成 → 準備完了 → キー取得 → 接続保存 ============ */
group("F: プロジェクト作成の全フロー（組織1つ）");
{
  freshSb({ statusQueue: ["COMING_UP", "ACTIVE_HEALTHY"] });
  seedSbp();
  let result = "";
  try {
    result = await supabaseCreateProjectTool({ name: "my-app" });
  } catch (e) {
    ok(false, `F0: 例外なく完了する（実際: ${e && e.message}）`);
  }
  ok(result.includes(REF), "F1: 結果に ref が含まれる");
  ok(result.includes(`https://${REF}.supabase.co`), "F2: 結果にプロジェクトURLが含まれる");
  ok(result.includes("データベース直接接続用"), "F3: 結果にDBパスワードの保存案内が含まれる");
  const m = result.match(/データベースパスワード: (\S+)/);
  ok(!!m && m[1].length >= 24, `F4: 24文字以上のDBパスワードが提示される（実際: ${m && m[1].length}文字）`);
  const saved = savedCreds();
  ok(!!saved && saved.url === `https://${REF}.supabase.co`, "F5: コネクタに新しいプロジェクトURLが保存される");
  ok(!!saved && saved.serviceKey === SERVICE_KEY, "F6: コネクタにサービスロールキーが保存される");
  ok(!!saved && saved.sbp === "sbp_test_token", "F7: sbp_ トークンが引き継がれる");
  ok(!!sb.createBody && sb.createBody.organization_id === "org-1", "F8: 作成先は唯一の組織になる");
  ok(!!sb.createBody && sb.createBody.region === "ap-northeast-1", "F9: 既定リージョンは東京（ap-northeast-1）");
  ok(!!sb.createBody && typeof sb.createBody.db_pass === "string" && sb.createBody.db_pass.length >= 24,
    "F10: 作成リクエストに24文字以上の db_pass が入る");
  ok(mgmtCalls.some((c) => c.method === "GET" && c.path.startsWith(`/v1/projects/${REF}/api-keys`)), "F11: APIキーを取得している");
}

/* ============ G: 組織が複数 + orgId なし → 一覧を返して作成しない ============ */
group("G: 組織が複数のとき");
{
  freshSb({ orgs: [{ id: "org-1", name: "Org One" }, { id: "org-2", name: "Org Two" }] });
  seedSbp();
  const result = await supabaseCreateProjectTool({ name: "my-app" });
  ok(result.includes("Org One") && result.includes("org-2"), "G1: 組織一覧が返る");
  ok(!mgmtCalls.some((c) => c.method === "POST" && c.path === "/v1/projects"), "G2: 作成APIは呼ばれない");
  /* orgId を指定すれば作れる */
  const result2 = await supabaseCreateProjectTool({ name: "my-app", orgId: "org-2" });
  ok(result2.includes(REF), "G3: orgId 指定で作成が進む");
  ok(!!sb.createBody && sb.createBody.organization_id === "org-2", "G4: 指定した組織に作成される");
}

/* ============ H: Management APIトークンが無い → 案内のみでAPIを呼ばない ============ */
group("H: トークンなしの案内");
{
  freshSb();
  update({ connectors: { supabase: JSON.stringify({ url: "https://oldproj.supabase.co", serviceKey: "svc_old", sbp: "" }) } });
  let err1 = "";
  try { await supabaseCreateProjectTool({ name: "x" }); } catch (e) { err1 = e.message; }
  ok(err1.includes("sbp_"), "H1: 作成は sbp_ またはログイン式への案内になる");
  update({ connectors: {} });
  let err2 = "";
  try { await supabaseOrgs(); } catch (e) { err2 = e.message; }
  ok(err2.includes("sbp_"), "H2: 組織一覧も同じ案内になる");
  ok(mgmtCalls.length === 0, "H3: api.supabase.com へのリクエストが発生しない");
}

/* ============ I: 準備が間に合わない → 状態と setup の案内、その後 setup で仕上げ ============ */
group("I: 準備中タイムアウト → supabase_project_setup");
{
  globalThis.__ELUNTRA_SB_POLL_TIMEOUT_MS = 40;
  freshSb({ statusQueue: ["COMING_UP"] });
  seedSbp();
  const result = await supabaseCreateProjectTool({ name: "slow-app" });
  ok(result.includes("準備中"), "I1: 準備中であることが返る");
  ok(result.includes("supabase_project_setup"), "I2: setup ツールへの案内が含まれる");
  ok(result.includes(REF), "I3: ref が含まれる");
  const mid = savedCreds();
  ok(!!mid && mid.url === "", "I4: 準備完了までは接続先を上書きしない");
  /* 準備が終わった状態で setup */
  sb.statusQueue = ["ACTIVE_HEALTHY"];
  const setupResult = await supabaseProjectSetupTool({ ref: REF });
  ok(setupResult.includes("接続しました"), "I5: setup で接続が仕上がる");
  const saved = savedCreds();
  ok(!!saved && saved.url === `https://${REF}.supabase.co` && saved.serviceKey === SERVICE_KEY,
    "I6: setup 後にURLとサービスロールキーが保存される");
  globalThis.__ELUNTRA_SB_POLL_TIMEOUT_MS = 120_000;
}

/* ============ J: Supabase のエラー（422・上限）がそのまま伝わる ============ */
group("J: 作成エラー（プラン上限）");
{
  freshSb({
    createError: {
      status: 422,
      body: { message: "You have reached the maximum number of projects for this organization" },
    },
  });
  seedSbp();
  let err = "";
  try { await supabaseCreateProjectTool({ name: "over-limit" }); } catch (e) { err = e.message; }
  ok(err.includes("maximum number of projects"), "J1: Supabaseのエラーメッセージが保持される");
  ok(err.includes("無料プラン"), "J2: 無料プランの上限の可能性が日本語で添えられる");
}

/* ============ K: エージェント経由（runAgent）で作成フローが動く ============ */
group("K: runAgent 経由の作成");
{
  freshSb({ statusQueue: ["ACTIVE_HEALTHY"] });
  seedSbp();
  update({ keys: { groq: "gsk_test" } });
  script = [toolJson("supabase_create_project", { name: "agent-app" }), "プロジェクトを作成しました。"];
  scriptIdx = 0;
  llmBodies.length = 0;
  let r = null;
  try {
    r = await runAgent(GROQ, "openai/gpt-oss-120b", [{ role: "user", content: "Supabaseのプロジェクトを作って" }], noProgress);
    ok(r.text === "プロジェクトを作成しました。", "K1: エージェントが最終回答まで完走する");
  } catch (e) {
    ok(false, `K1: エージェントが最終回答まで完走する（実際: ${e && e.message}）`);
  }
  const saved = savedCreds();
  ok(!!saved && saved.url === `https://${REF}.supabase.co`, "K2: エージェント経由でも接続が保存される");
  /* 2回目のLLMリクエストにツール結果（ref・パスワード案内）が渡っている */
  const second = llmBodies[1];
  const msgs = second?.messages || [];
  const toolResultMsg = msgs.map((mm) => String(mm.content || "")).join("\n");
  ok(toolResultMsg.includes(REF) && toolResultMsg.includes("データベース直接接続用"),
    "K3: ツール結果（ref・パスワード案内）がモデルへ渡る");
  ok(r_stepsInclude(r), "K4: 手順にプロジェクト作成が記録される");
}
function r_stepsInclude(r) {
  return !!r && Array.isArray(r.steps) && r.steps.some((s) => s.includes("プロジェクトを作成中"));
}

console.log(`\n===== 結果: ${pass} pass / ${fail} fail =====`);
if (failures.length) { console.log("失敗:", failures.join(" / ")); process.exit(1); }
