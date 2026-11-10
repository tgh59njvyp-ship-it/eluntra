/* Eluntra Developer ターミナル滞留対策（v7.2.9）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-terminal.test.mjs
   検証する不具合: 「2/25 の手順（ターミナル）で毎回止まる」
   - term_exec が何も返さない場合でも、エージェント側の上限で打ち切って作業を続ける
   - 環境レベルの失敗が判明した後の term_exec は実行せずに短絡し、ファイル作業を完遂する
   - 開発サーバー系コマンドは exec ではなくサーバー起動へ回す判定が正しい
   LLM は mock-chat.mjs 経由の台本モデル。WebContainer 本体は Node では動かないため、
   段階タイムアウトは withTimeout の純粋関数として検証する。 */

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const {
  runDevAgent, TERM_EXEC_LIMIT, withTimeout, PhaseTimeoutError,
  isDevServerCommand, isTerminalEnvUnavailable, TERMINAL_UNAVAILABLE_PREFIX, WC_TIMEOUTS,
} = bundle;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";

/** 台本モデル。responder(callIndex, history, state) が次の応答文字列を返す */
function scripted(responder) {
  const state = { calls: 0, results: [] };
  globalThis.__mockLLM = async (history) => {
    const last = history[history.length - 1];
    if (last && typeof last.content === "string" && last.content.includes("の結果:")) state.results.push(last.content);
    const idx = state.calls++;
    return responder(idx, history, state);
  };
  return state;
}

function makeCtx(initialFiles, opts = {}) {
  let files = { ...initialFiles };
  const events = [];
  const ctx = {
    getFiles: () => files,
    applyFiles: (f) => { files = f; },
    confirm: opts.confirm || (async () => true),
    termExec: opts.termExec || (async (cmd) => `executed: ${cmd}`),
    previewInfo: () => "プレビューは未起動です",
    sessionFiles: new Set(opts.sessionFiles || []),
    onEvent: (e) => events.push(e),
  };
  return { ctx, events, files: () => files };
}

const PROVIDER = { id: "mock", kind: "openai" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============ A: withTimeout の純粋動作 ============ */
group("A: withTimeout は速い処理を通し、遅い処理を段階名つきで打ち切る");
{
  const v = await withTimeout(sleep(5).then(() => "ok"), 1000, "テスト段階");
  ok(v === "ok", "A1: 制限内の処理は結果を返す");
  let caught = null;
  try {
    await withTimeout(sleep(500), 30, "WebContainerの起動");
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof PhaseTimeoutError, "A2: 制限超過は PhaseTimeoutError");
  ok(!!caught && caught.phase === "WebContainerの起動", "A3: エラーが段階名を保持する");
  ok(!!caught && caught.message.includes("WebContainerの起動"), "A4: 文面に段階名が入る");
  ok(WC_TIMEOUTS.bootMs <= 60_000 && WC_TIMEOUTS.mountMs <= 60_000 && WC_TIMEOUTS.spawnMs <= 60_000, "A5: 各段階の上限が設定されている");
}

/* ============ B: 開発サーバー系コマンドの判定 ============ */
group("B: isDevServerCommand（サーバー系は exec に流さない）");
{
  for (const c of ["npm run dev", "npm start", "npm run serve", "pnpm dev", "yarn dev", "bun run dev", "vite", "vite dev", "npx vite", "npx vite --port 5173", "npm run dev -- --host"]) {
    ok(isDevServerCommand(c), `B+: ${c}`);
  }
  for (const c of ["npm run build", "npm install", "npm test", "node server.js", "npm run dev && npm run build", "npm run dev; ls", "ls", ""]) {
    ok(!isDevServerCommand(c), `B-: ${c || "（空）"}`);
  }
}

/* ============ C: 環境レベル失敗の分類 ============ */
group("C: isTerminalEnvUnavailable（コマンド失敗と環境失敗を区別する）");
{
  ok(isTerminalEnvUnavailable(`${TERMINAL_UNAVAILABLE_PREFIX}: WebContainerの起動が60秒でタイムアウトしました`), "C1: 利用不可の接頭辞を検出");
  ok(!isTerminalEnvUnavailable("$ npm run build\n（120秒でタイムアウトし、停止しました）"), "C2: コマンド自体のタイムアウトは環境失敗ではない");
  ok(!isTerminalEnvUnavailable("$ npm test\n（終了コード: 1）"), "C3: 終了コード非0は環境失敗ではない");
  ok(!isTerminalEnvUnavailable("executed: npm run build"), "C4: 通常出力は環境失敗ではない");
}

/* ============ D: (a) 応答しない term_exec を打ち切り、作業を続ける ============ */
group("D: term_exec が何も返さなくても実行が止まらない");
{
  const prevLimit = TERM_EXEC_LIMIT.timeoutMs;
  TERM_EXEC_LIMIT.timeoutMs = 50;
  try {
    let termCalls = 0;
    const st = scripted((i) => {
      if (i === 0) return toolJson("term_exec", { command: "npm run build" });
      if (i === 1) return toolJson("fs_write", { path: "src/App.tsx", content: "export const x = 1;" });
      return "作成しました。実行確認は未確認です。";
    });
    const { ctx, files } = makeCtx({}, {
      termExec: () => { termCalls++; return new Promise(() => undefined); }, // 永遠に返らない
    });
    const started = Date.now();
    const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
    const elapsed = Date.now() - started;
    ok(elapsed < 10_000, `D1: ハングせずに打ち切った（${elapsed}ms）`);
    ok(termCalls === 1, "D2: termExec は1回だけ呼ばれた");
    ok(files()["src/App.tsx"] === "export const x = 1;", "D3: その後のファイル作成が実行された");
    ok(res.text.includes("未確認"), "D4: 最終回答まで到達した");
    ok(!res.stopped, "D5: stopped になっていない");
    ok(st.results.some((r) => r.includes(TERMINAL_UNAVAILABLE_PREFIX)), "D6: モデルへ環境レベルの失敗として伝わった");
  } finally {
    TERM_EXEC_LIMIT.timeoutMs = prevLimit;
  }
}

/* ============ E: (b) 環境失敗後の term_exec は短絡し、ファイル作業を完遂する ============ */
group("E: 環境レベルの失敗が判明した後の term_exec は実行されない");
{
  let termCalls = 0;
  const st = scripted((i) => {
    if (i === 0) return toolJson("term_exec", { command: "npm run build" });
    if (i === 1) return toolJson("term_exec", { command: "npm test" });
    if (i === 2) return toolJson("term_exec", { command: "npm run build" }); // 同一コマンドの再試行も短絡されること
    if (i === 3) return toolJson("fs_write", { path: "index.html", content: "<html></html>" });
    return "完了しました（実行確認は未確認）";
  });
  const { ctx, files } = makeCtx({}, {
    termExec: async () => {
      termCalls++;
      return `${TERMINAL_UNAVAILABLE_PREFIX}: WebContainerの起動が60秒でタイムアウトしました。起動が応答しないため、このページを開いている間はターミナルを利用できません。`;
    },
  });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "auto", history: [], userText: "作って", ctx });
  ok(termCalls === 1, `E1: termExec の実呼び出しは1回だけ（実際: ${termCalls}回）`);
  ok(st.results.some((r) => r.includes("二度と呼ばないでください")), "E2: 初回の結果に「もう呼ぶな」の指示が付いた");
  ok(st.results.filter((r) => r.includes("再試行はしません")).length >= 2, "E3: 2回目以降は短絡結果が返った");
  ok(files()["index.html"] === "<html></html>", "E4: ファイル作成が実行された");
  ok(res.text.includes("未確認") && !res.stopped, "E5: 最終回答まで完遂した");
}

/* ============ F: (d) 通常のコマンドはこれまで通り動く（回帰） ============ */
group("F: 正常な term_exec は結果が届き、実行が進む");
{
  let termCalls = 0;
  const st = scripted((i) => {
    if (i === 0) return toolJson("term_exec", { command: "npm run build" });
    return "ビルド成功を確認しました";
  });
  const { ctx } = makeCtx({}, {
    termExec: async (cmd) => { termCalls++; return `$ ${cmd}\nbuild ok\n（終了コード: 0）`; },
  });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(termCalls === 1, "F1: termExec が実行された");
  ok(st.results.some((r) => r.includes("build ok")), "F2: 出力がモデルへ届いた");
  ok(res.text.includes("ビルド成功"), "F3: 最終回答まで到達した");
  ok(!st.results.some((r) => r.includes("二度と呼ばないでください")), "F4: 正常時は使用不可の指示が付かない");
}

/* ============ G: 25手順を超える生産的な作業が打ち切られない ============ */
group("G: 25手順固定の撤廃（生産的な手順は25超でも継続する）");
{
  const WRITES = 32;
  const st = scripted((i) => {
    if (i < WRITES) return toolJson("fs_write", { path: `src/f${i}.ts`, content: `export const v${i} = ${i};` });
    return "全ファイルを作成しました";
  });
  const { ctx, events, files } = makeCtx({});
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "たくさん作って", ctx });
  ok(st.calls === WRITES + 1, `G1: LLM呼び出しが25で打ち切られず ${WRITES + 1} 回行われた（実際: ${st.calls}回）`);
  ok(Object.keys(files()).length === WRITES, "G2: 32ファイルすべて作成された");
  ok(files()["src/f31.ts"] === "export const v31 = 31;", "G3: 25を超えた後の書き込みも実行された");
  ok(res.text.includes("全ファイルを作成しました") && !res.stopped, "G4: 最終回答まで完走した");
  const stepEvents = events.filter((e) => e.kind === "step" && typeof e.step === "number");
  ok(stepEvents.some((e) => e.step > 25), "G5: 手順26以降のステップイベントが流れた");
  ok(stepEvents.every((e) => e.max === undefined), "G6: ステップイベントに分母（max）が付いていない");
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (fail) {
  console.log("失敗:", failures.join(" / "));
  process.exit(1);
}
