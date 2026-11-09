/* Eluntra Developer エージェント: 本体共有ツール（Supabase等）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-exttools.test.mjs
   LLM は mock-chat.mjs 経由の台本モデル、外部APIは fetch スタブで再現する。
   実キー・実アカウントは使わない。 */

const lsData = new Map();
globalThis.localStorage = {
  getItem: (k) => (lsData.has(k) ? lsData.get(k) : null),
  setItem: (k, v) => lsData.set(k, String(v)),
  removeItem: (k) => lsData.delete(k),
};
globalThis.window = globalThis;
/* プロジェクト作成のポーリングをテスト用に短縮（本番は10秒間隔） */
globalThis.__ELUNTRA_SB_POLL_MS = 5;
globalThis.__ELUNTRA_SB_POLL_TIMEOUT_MS = 120_000;

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const { runDevAgent, buildDevToolGuide, sharedToolAvailability, getState, update } = bundle;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";

/* ---------- fetch スタブ（Supabase REST / Management API / 検索） ---------- */
const REF = "projref1234567890ab";
const NEWREF = "newref0987654321zz";
const fetchLog = []; // { method, url }

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || "GET").toUpperCase();
  fetchLog.push({ method, url: u });
  if (u.startsWith("https://eluntra.vercel.app/api/search")) {
    return jsonRes({ results: [{ title: "検索ヒット", url: "https://example.com/hit", snippet: "スニペット" }] });
  }
  if (u === `https://${REF}.supabase.co/rest/v1/`) {
    return jsonRes({ definitions: { users: {}, posts: {} }, paths: {} });
  }
  if (u.startsWith(`https://${REF}.supabase.co/rest/v1/users`)) {
    if (method === "GET") return jsonRes([{ id: 1, name: "A" }]);
    if (method === "DELETE") return jsonRes([]);
    if (method === "POST") return jsonRes([{ id: 2, name: "x" }], 201);
  }
  if (u === "https://api.supabase.com/v1/organizations") {
    return jsonRes([{ id: "org-1", name: "My Org" }]);
  }
  if (u === "https://api.supabase.com/v1/projects" && method === "POST") {
    return jsonRes({ id: NEWREF, ref: NEWREF, name: "dev-proj", region: "ap-northeast-1", status: "COMING_UP" }, 201);
  }
  if (u === `https://api.supabase.com/v1/projects/${NEWREF}`) {
    return jsonRes({ id: NEWREF, ref: NEWREF, name: "dev-proj", region: "ap-northeast-1", status: "ACTIVE_HEALTHY" });
  }
  if (u === `https://api.supabase.com/v1/projects/${NEWREF}/api-keys`) {
    return jsonRes([
      { name: "anon", api_key: "anon-key-new" },
      { name: "service_role", api_key: "svc-key-new" },
    ]);
  }
  if (u === `https://api.supabase.com/v1/projects/${REF}/database/query` && method === "POST") {
    return jsonRes([{ n: 42 }]);
  }
  return new Response("not stubbed: " + u, { status: 404 });
};

const fetchesSince = (mark, pred) => fetchLog.slice(mark).filter(pred);

/* ---------- 台本モデル + ctx ---------- */
function scripted(responder) {
  const state = { calls: 0, results: [], guides: [] };
  globalThis.__mockLLM = async (history) => {
    if (history[0]) state.guides.push(history[0].content);
    const last = history[history.length - 1];
    if (last && typeof last.content === "string" && last.content.includes("の結果:")) state.results.push(last.content);
    const idx = state.calls++;
    return responder(idx, history, state);
  };
  return state;
}

function makeCtx(opts = {}) {
  let files = {};
  const events = [];
  const ctx = {
    getFiles: () => files,
    applyFiles: (f) => { files = f; },
    confirm: opts.confirm || (async () => true),
    termExec: async (cmd) => `executed: ${cmd}`,
    previewInfo: () => "プレビューは未起動です",
    sessionFiles: new Set(),
    onEvent: (e) => events.push(e),
  };
  return { ctx, events };
}

const PROVIDER = { id: "mock", kind: "openai" };
const SB_CREDS = JSON.stringify({ url: `https://${REF}.supabase.co`, serviceKey: "svc-key", sbp: "sbp_test" });
function connectSupabase() {
  update({ connectors: { ...(getState().connectors || {}), supabase: SB_CREDS } });
}
function disconnectAll() {
  update({ connectors: {} });
}

/* ============ K3: 未接続時はガイドに Supabase ツールが出ない ============ */
group("K3: 動的ツール提示（未接続）");
{
  disconnectAll();
  const avail = sharedToolAvailability();
  ok(avail.supabase === false && avail.github === false, "K3-1: 未接続では availability が false");
  const guide = buildDevToolGuide(avail);
  ok(!guide.includes("supabase_tables"), "K3-2: ガイドに supabase_tables が含まれない");
  ok(!guide.includes("github_repos"), "K3-3: ガイドに github_repos が含まれない");
  ok(guide.includes("未接続のため") && guide.includes("Supabase"), "K3-4: 未接続サービスの案内行がある");
  ok(guide.includes("web_search") && guide.includes("save_note"), "K3-5: 常時ツールは提示される");
  // 実行時のプロンプト（convo 先頭）でも同じになること
  const st = scripted(() => "分かりました。");
  const { ctx } = makeCtx();
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "こんにちは", ctx });
  ok(st.guides.length > 0 && !st.guides[0].includes("supabase_create_project"), "K3-6: 実行プロンプトにも Supabase ツールが無い");
  ok(st.guides[0].includes("未接続のため"), "K3-7: 実行プロンプトに未接続の案内がある");
}

/* ============ K1: BUILD で Supabase 読み取りフロー ============ */
group("K1: BUILD（supabase_tables → supabase_sql SELECT）");
{
  connectSupabase();
  const avail = sharedToolAvailability();
  ok(avail.supabase === true, "K1-1: 接続後は availability.supabase が true");
  const guide = buildDevToolGuide(avail);
  ok(guide.includes("supabase_tables") && guide.includes("supabase_create_project"), "K1-2: 接続後はガイドに Supabase ツール群が出る");
  const mark = fetchLog.length;
  let confirmCalls = 0;
  const seq = [
    toolJson("supabase_tables", {}),
    toolJson("supabase_sql", { query: "select 42 as n" }),
    "完了しました。",
  ];
  const st = scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, events } = makeCtx({ confirm: async () => { confirmCalls++; return true; } });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "Supabaseを見て", ctx });
  ok(!res.stopped && res.text === "完了しました。", "K1-3: 正常完了");
  ok(st.results.some((r) => r.includes("テーブル一覧") && r.includes("users")), "K1-4: テーブル一覧がモデルに返った");
  ok(st.results.some((r) => r.includes("42")), "K1-5: SQL（SELECT）の結果がモデルに返った");
  ok(events.some((e) => e.kind === "step" && e.label.includes("Supabase: テーブル一覧")), "K1-6: タイムラインに「Supabase: テーブル一覧」");
  ok(events.some((e) => e.kind === "step" && e.label.includes("Supabase: SQL実行")), "K1-7: タイムラインに「Supabase: SQL実行」");
  ok(fetchesSince(mark, (f) => f.method === "GET" && f.url.includes("/rest/v1/")).length >= 1, "K1-8: REST への取得が発生した");
  ok(fetchesSince(mark, (f) => f.method === "POST" && f.url.includes("/database/query")).length === 1, "K1-9: Management API へ SQL が送られた");
  ok(confirmCalls === 0, "K1-10: SELECT では確認が入らない");
}

/* ============ K2: PLAN では書き込み拒否・読み取り許可 ============ */
group("K2: PLAN のモード制限（supabase_insert 拒否 / select 許可）");
{
  connectSupabase();
  const mark = fetchLog.length;
  const seq = [
    toolJson("supabase_insert", { table: "users", row: "{\"name\":\"x\"}" }),
    toolJson("supabase_select", { table: "users" }),
    "報告します。",
  ];
  const st = scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx } = makeCtx();
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "plan", history: [], userText: "調べて", ctx });
  ok(!res.stopped, "K2-1: 正常完了");
  ok(st.results.some((r) => r.includes("拒否しました")), "K2-2: PLAN で insert がツール層で拒否された");
  ok(fetchesSince(mark, (f) => f.method === "POST" && f.url.includes("/rest/v1/users")).length === 0, "K2-3: insert の API は呼ばれていない");
  ok(st.results.some((r) => r.includes("\"A\"") || r.includes("A")), "K2-4: select の結果がモデルに返った");
  ok(fetchesSince(mark, (f) => f.method === "GET" && f.url.includes("/rest/v1/users")).length === 1, "K2-5: select の API は呼ばれた");
}

/* ============ K4: supabase_delete の確認フロー ============ */
group("K4: BUILD の supabase_delete（確認1回・拒否で未実行）");
{
  connectSupabase();
  // 拒否ケース
  const markA = fetchLog.length;
  let confirmsA = 0;
  const seqA = [toolJson("supabase_delete", { table: "users", filter: "id=1" }), "やめました。"];
  const stA = scripted((i) => seqA[Math.min(i, seqA.length - 1)]);
  const a = makeCtx({ confirm: async () => { confirmsA++; return false; } });
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "消して", ctx: a.ctx });
  ok(confirmsA === 1, "K4-1: delete の確認はちょうど1回");
  ok(fetchesSince(markA, (f) => f.method === "DELETE").length === 0, "K4-2: 拒否されたら DELETE は呼ばれない");
  ok(stA.results.some((r) => r.includes("承認しなかった")), "K4-3: 拒否がモデルに伝わる");
  // 承認ケース
  const markB = fetchLog.length;
  let confirmsB = 0;
  const seqB = [toolJson("supabase_delete", { table: "users", filter: "id=1" }), "削除を終えました。"];
  const stB = scripted((i) => seqB[Math.min(i, seqB.length - 1)]);
  const b = makeCtx({ confirm: async () => { confirmsB++; return true; } });
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "消して", ctx: b.ctx });
  ok(confirmsB === 1, "K4-4: 承認ケースでも確認は1回");
  ok(fetchesSince(markB, (f) => f.method === "DELETE" && f.url.includes("/rest/v1/users")).length === 1, "K4-5: 承認されたら DELETE が実行される");
  ok(stB.results.some((r) => r.includes("削除しました")), "K4-6: 削除結果がモデルに返った");
}

/* ============ K5: supabase_create_project（dev エージェント配線） ============ */
group("K5: supabase_create_project（BUILD で作成→自動接続 / PLAN で拒否）");
{
  connectSupabase();
  // PLAN ではツール層で拒否され、作成APIを呼ばない
  const markP = fetchLog.length;
  const seqP = [toolJson("supabase_create_project", { name: "dev-proj" }), "計画のみです。"];
  const stP = scripted((i) => seqP[Math.min(i, seqP.length - 1)]);
  const pc = makeCtx();
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "plan", history: [], userText: "作って", ctx: pc.ctx });
  ok(stP.results.some((r) => r.includes("拒否しました")), "K5-1: PLAN では create_project が拒否される");
  ok(fetchesSince(markP, (f) => f.method === "POST" && f.url === "https://api.supabase.com/v1/projects").length === 0, "K5-2: PLAN では作成APIを呼ばない");
  // BUILD では確認→作成→準備完了→キー取得→コネクタ保存まで完走する
  const mark = fetchLog.length;
  let confirms = 0;
  const seq = [toolJson("supabase_create_project", { name: "dev-proj" }), "作りました。"];
  const st = scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, events } = makeCtx({ confirm: async () => { confirms++; return true; } });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "Supabaseのプロジェクトを作って", ctx });
  ok(!res.stopped && res.text === "作りました。", "K5-3: 正常完了");
  ok(confirms === 1, "K5-4: 作成前に確認が1回入る");
  ok(fetchesSince(mark, (f) => f.method === "POST" && f.url === "https://api.supabase.com/v1/projects").length === 1, "K5-5: 作成APIが呼ばれた");
  ok(fetchesSince(mark, (f) => f.url.includes("/api-keys")).length >= 1, "K5-6: APIキーが取得された");
  ok(st.results.some((r) => r.includes("接続しました") && r.includes(NEWREF)), "K5-7: 結果に ref と接続完了が含まれる");
  const saved = JSON.parse(getState().connectors.supabase || "{}");
  ok(saved.url === `https://${NEWREF}.supabase.co`, "K5-8: コネクタに新しいプロジェクトURLが保存された");
  ok(saved.serviceKey === "svc-key-new", "K5-9: サービスロールキーが保存された");
  ok(saved.sbp === "sbp_test", "K5-10: sbp_ トークンが引き継がれた");
  ok(events.some((e) => e.kind === "step" && e.label.includes("Supabase: プロジェクト作成")), "K5-11: タイムラインに「Supabase: プロジェクト作成」");
}

/* ============ K6: web_search（常時ツール）の動作 ============ */
group("K6: web_search が Developer でも使える");
{
  const seq = [toolJson("web_search", { query: "Eluntra" }), "調べました。"];
  const st = scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, events } = makeCtx();
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "ask", history: [], userText: "調べて", ctx });
  ok(!res.stopped && res.text === "調べました。", "K6-1: 正常完了");
  ok(st.results.some((r) => r.includes("検索ヒット")), "K6-2: 検索結果がモデルに返った");
  ok(events.some((e) => e.kind === "step" && e.label.includes("Webを検索")), "K6-3: タイムラインに「Webを検索」");
}

console.log(`\n===== 結果: ${pass} pass / ${fail} fail =====`);
if (failures.length) { console.log("失敗:", failures.join(" / ")); process.exit(1); }
