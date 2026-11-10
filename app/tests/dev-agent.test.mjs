/* Eluntra Developer エージェント/FS/DB 単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-agent.test.mjs
   LLM は mock-chat.mjs 経由の台本モデルに差し替えている。実キー・実モデルは使わない。 */

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const { runDevAgent, EXPLORE_BUDGET, EXPLORE_BUDGET_READONLY_MODE, STALL_LIMIT, DEV_AGENT_BACKOFF, RateLimitError, fsMod, isReadOnlySql } = bundle;
const { runFsTool, runFsWriteMany, runFsReadMany, createFile, writeFile, renamePath, deletePath, applyExactEdit, searchFiles, diffLines, diffStat, UndoManager, revertChange, TEMPLATES, buildStaticPreview, listPaths } = fsMod;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";

/** 台本モデル。responder(callIndex, history) が次の応答文字列を返す */
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
    termExec: async (cmd) => `executed: ${cmd}`,
    previewInfo: () => "プレビューは未起動です",
    dbList: async () => "app（SQLite）",
    dbSchema: async () => "テーブル: users(id, name)",
    dbQuery: opts.dbQuery || (async (_db, sql) => `query ok: ${sql}`),
    sessionFiles: new Set(opts.sessionFiles || []),
    onEvent: (e) => events.push(e),
  };
  return { ctx, events, files: () => files };
}

const PROVIDER = { id: "mock", kind: "openai" };

/* ============ A: 引数を変えた fs_list 連打（今回の不具合の再現） ============ */
group("A: fs_list を引数を変えて繰り返すループが早期に止まる");
{
  const varied = [{ path: "src" }, { path: "src/ui" }, { path: "lib" }, { depth: "2" }, { path: "docs" }, { path: "app" }, { path: "x" }, { path: "y" }];
  const st = scripted((i) => toolJson("fs_list", varied[i % varied.length]));
  const { ctx, events } = makeCtx({ "index.html": "<html></html>", "src/App.tsx": "x" });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "アプリを作って", ctx });
  ok(!!res.stopped, "A1: stopped が返る");
  ok(!!res.stopped && res.stopped.includes("ループを避けて停止しました"), "A2: 停滞メッセージ文面");
  ok(!!res.stopped && res.stopped.includes("fs_list"), "A3: 停滞メッセージがツール名を含む");
  ok(st.calls <= 8, `A4: 25手順上限より十分早く停止（LLM呼び出し ${st.calls} 回）`);
  ok(st.results.some((r) => r.includes("この結果は取得済みです")), "A5: 重複結果の要約通知がモデルに届いた");
  const stepEvents = events.filter((e) => e.kind === "step" && typeof e.step === "number");
  ok(stepEvents.length > 0 && stepEvents[0].step === 1 && stepEvents[0].max === undefined, "A6: ステップ番号だけがイベントに含まれ、分母（max）は付かない（v7.2.9で25手順固定を撤廃）");
}

/* ============ B: 異なるファイルの連続読み取りで探索上限の拒否が届く ============ */
group("B: 探索予算の拒否がモデルに届き、その後停止する");
{
  const files = {};
  for (let i = 1; i <= 10; i++) files[`f${i}.txt`] = `content ${i}`;
  const st = scripted((i) => toolJson("fs_read", { path: `f${(i % 10) + 1}.txt` }));
  const { ctx } = makeCtx(files);
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(st.results.some((r) => r.includes("これ以上プロジェクトを探索できません")), "B1: 探索上限の拒否文がモデルに届いた");
  ok(!!res.stopped && res.stopped.includes("ループを避けて停止しました"), "B2: 拒否後も続けると停滞停止する");
  ok(st.calls <= EXPLORE_BUDGET + 3, `B3: 早期停止（LLM呼び出し ${st.calls} 回 / 予算 ${EXPLORE_BUDGET}）`);
}

/* ============ C: 通常の BUILD フローは影響を受けない ============ */
group("C: 通常の BUILD（list→write×2→完了）");
{
  const seq = [
    toolJson("fs_list", {}),
    toolJson("fs_write", { path: "src/new1.ts", content: "export const a = 1;\n" }),
    toolJson("fs_write", { path: "src/new2.ts", content: "export const b = 2;\n" }),
    "2つのファイルを作成しました。",
  ];
  scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, events, files } = makeCtx({ "index.html": "<html></html>" });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "ファイルを作って", ctx });
  ok(!res.stopped, "C1: stopped なしで完了");
  ok(res.text === "2つのファイルを作成しました。", "C2: 最終報告がそのまま返る");
  ok(files()["src/new1.ts"]?.includes("a = 1") && files()["src/new2.ts"]?.includes("b = 2"), "C3: 2ファイルとも作成された");
  ok(events.filter((e) => e.kind === "change").length === 2, "C4: 変更イベントが2件");
}

/* ============ D: PLAN は広い探索予算を使える ============ */
group("D: PLAN モードの探索（予算10）");
{
  const files = {};
  for (let i = 1; i <= 12; i++) files[`f${i}.txt`] = `content ${i}`;
  // D1: 8件読んで回答
  const st1 = scripted((i) => (i < 8 ? toolJson("fs_read", { path: `f${i + 1}.txt` }) : "計画をまとめました。"));
  const c1 = makeCtx(files);
  const r1 = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "plan", history: [], userText: "計画して", ctx: c1.ctx });
  ok(!r1.stopped && r1.text === "計画をまとめました。", "D1: PLAN で8件の読み取り後に正常完了");
  ok(!st1.results.some((r) => r.includes("取得済み")), "D2: 異なるファイルの読み取りは重複扱いにならない");
  // D2: 11件目で拒否が届くが、回答すれば正常完了する
  const st2 = scripted((i) => (i < 11 ? toolJson("fs_read", { path: `f${i + 1}.txt` }) : "調査結果をまとめました。"));
  const c2 = makeCtx(files);
  const r2 = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "plan", history: [], userText: "調べて", ctx: c2.ctx });
  ok(st2.results.some((r) => r.includes("これ以上の探索はできません")), `D3: PLAN でも予算 ${EXPLORE_BUDGET_READONLY_MODE} 超過で拒否が届く`);
  ok(!r2.stopped && r2.text === "調査結果をまとめました。", "D4: 拒否後に回答すれば正常完了");
}

/* ============ E: v7.1 エージェント回帰（確認フロー・読み取り専用） ============ */
group("E: エージェント回帰（確認・拒否・モード制限）");
{
  // E1: 既存ファイル上書きは初回だけ確認し、2回目は確認しない
  let confirmCalls = 0;
  const seq1 = [
    toolJson("fs_write", { path: "src/App.tsx", content: "v1" }),
    toolJson("fs_write", { path: "src/App.tsx", content: "v2" }),
    "更新しました。",
  ];
  scripted((i) => seq1[Math.min(i, seq1.length - 1)]);
  const e1 = makeCtx({ "src/App.tsx": "orig" }, { confirm: async () => { confirmCalls++; return true; } });
  const rE1 = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "直して", ctx: e1.ctx });
  ok(confirmCalls === 1, "E1: 既存ファイルの確認はちょうど1回");
  ok(e1.files()["src/App.tsx"] === "v2", "E2: 2回目の内容まで反映された");
  ok(!rE1.stopped, "E3: 正常完了");
  // E2: 確認を拒否するとファイルは変わらない
  const seq2 = [toolJson("fs_write", { path: "src/App.tsx", content: "vX" }), "断念しました。"];
  scripted((i) => seq2[Math.min(i, seq2.length - 1)]);
  const e2 = makeCtx({ "src/App.tsx": "orig" }, { confirm: async () => false });
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "直して", ctx: e2.ctx });
  ok(e2.files()["src/App.tsx"] === "orig", "E4: 確認拒否で元ファイル不変");
  // E3: PLAN では書き込みが拒否される
  const st3 = scripted((i) => (i === 0 ? toolJson("fs_write", { path: "x.ts", content: "x" }) : "計画です。"));
  const e3 = makeCtx({});
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "plan", history: [], userText: "計画", ctx: e3.ctx });
  ok(!("x.ts" in e3.files()), "E5: PLAN ではファイルが作られない");
  ok(st3.results.some((r) => r.includes("変更できません")), "E6: モード拒否の文面がモデルに届く");
}

/* ============ F: DB ツールのモード制限 ============ */
group("F: DB ツール（読み取り専用モードの書き込みSQL拒否）");
{
  ok(isReadOnlySql("SELECT * FROM users") === true, "F1: SELECT は読み取り");
  ok(isReadOnlySql("INSERT INTO users VALUES (1)") === false, "F2: INSERT は書き込み");
  ok(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x") === true, "F3: WITH+SELECT は読み取り");
  ok(isReadOnlySql("WITH x AS (SELECT 1) DELETE FROM users") === false, "F4: WITH+DELETE は書き込み");
  let queried = 0;
  const st = scripted((i) => {
    if (i === 0) return toolJson("db_query", { db: "app", sql: "DELETE FROM users" });
    if (i === 1) return toolJson("db_query", { db: "app", sql: "SELECT * FROM users" });
    return "確認しました。";
  });
  const { ctx } = makeCtx({}, { dbQuery: async () => { queried++; return "ok"; } });
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "plan", history: [], userText: "DBを見て", ctx });
  ok(queried === 1, "F5: PLAN では書き込みSQLだけが実行されず、SELECT は実行される");
  ok(st.results.some((r) => r.includes("書き込みSQLは実行できません")), "F6: 拒否文がモデルに届く");
}

/* ============ G: FS 純粋関数 回帰 ============ */
group("G: FS 回帰");
{
  let f = {};
  f = createFile(f, "a/b.txt", "hello");
  ok(f["a/b.txt"] === "hello", "G1: createFile");
  let threw = false;
  try { createFile(f, "a/b.txt", "x"); } catch { threw = true; }
  ok(threw, "G2: 既存ファイルの createFile は例外");
  f = writeFile(f, "a/c.txt", "world");
  ok(listPaths(f).length === 2, "G3: writeFile で追加");
  f = renamePath(f, "a/c.txt", "a/d.txt");
  ok(!("a/c.txt" in f) && f["a/d.txt"] === "world", "G4: renamePath");
  f = renamePath(f, "a", "z");
  ok(f["z/b.txt"] === "hello" && f["z/d.txt"] === "world", "G5: フォルダごと移動");
  f = deletePath(f, "z/b.txt");
  ok(!("z/b.txt" in f) && listPaths(f).length === 1, "G6: deletePath");
  ok(applyExactEdit("aXbYc", "X", "Z") === "aZbYc", "G7: applyExactEdit 単一");
  threw = false;
  try { applyExactEdit("aXbXc", "X", "Y", false); } catch { threw = true; }
  ok(threw, "G8: 複数一致で replaceAll=false は例外（一意に特定させる）");
  ok(applyExactEdit("aXbXc", "X", "Y", true) === "aYbYc", "G9: applyExactEdit replaceAll");
  threw = false;
  try { applyExactEdit("abc", "Z", "Y"); } catch { threw = true; }
  ok(threw, "G10: 見つからない置換は例外");
  const hits = searchFiles({ "x.ts": "foo\nbar foo\n", "y.ts": "none\n" }, "foo");
  ok(hits.length === 2 && hits[0].line === 1, "G11: searchFiles");
  const d = diffLines("a\nb\nc", "a\nB\nc");
  ok(d.filter((l) => l.type === "add").length === 1 && d.filter((l) => l.type === "del").length === 1, "G12: diffLines");
  const stt = diffStat("", "a\nb");
  ok(stt.added === 2 && stt.removed === 0, "G13: diffStat");
  const um = new UndoManager();
  um.push("p", "v0", "v1");
  ok(um.canUndo("p") && um.undo("p", "v1") === "v0", "G14: Undo");
  ok(um.canRedo("p") && um.redo("p", "v0") === "v1", "G15: Redo");
  const r1 = runFsTool({}, "fs_write", { path: "src/a.ts", content: "A" });
  ok(r1.change?.kind === "create" && r1.files["src/a.ts"] === "A", "G16: runFsTool fs_write 作成");
  const r2 = runFsTool(r1.files, "fs_edit", { path: "src/a.ts", old: "A", new: "B" });
  ok(r2.files["src/a.ts"] === "B" && r2.change?.kind === "edit", "G17: runFsTool fs_edit");
  const r3 = runFsTool(r2.files, "fs_list", {});
  ok(r3.output.includes("src/a.ts") && r3.output.includes("bytes"), "G18: fs_list はパスとサイズのみ");
  const r4 = runFsTool(r2.files, "fs_read", { path: "src/a.ts" });
  ok(r4.output === "B", "G19: runFsTool fs_read");
  const r5 = runFsTool(r2.files, "code_search", { query: "B" });
  ok(r5.output.includes("src/a.ts:1"), "G20: runFsTool code_search");
  const back = revertChange(r2.files, r2.change);
  ok(back["src/a.ts"] === "A", "G21: revertChange で編集を取り消し");
  const r6 = runFsTool(r2.files, "fs_delete", { path: "src/a.ts" });
  ok(!("src/a.ts" in r6.files) && r6.change?.kind === "delete", "G22: runFsTool fs_delete");
  const backDel = revertChange(r6.files, r6.change);
  ok(backDel["src/a.ts"] === "B", "G23: revertChange で削除を取り消し");
  ok(TEMPLATES.length === 3, "G24: テンプレート3種");
  const tpl = TEMPLATES.find((t) => t.id === "static").files();
  ok(buildStaticPreview(tpl) !== null, "G25: 静的プレビュー生成");
  threw = false;
  try { runFsTool({}, "fs_read", { path: "none.txt" }); } catch { threw = true; }
  ok(threw, "G26: 存在しない fs_read は例外");
  const um2 = new UndoManager();
  um2.push("p", "same", "same");
  ok(!um2.canUndo("p"), "G27: 変化なしは履歴に積まない");
  ok(runFsTool({ "a.txt": "1" }, "fs_list", { path: "sub" }).output === runFsTool({ "a.txt": "1" }, "fs_list", {}).output, "G28: fs_list は引数によらず同じ結果（重複判定の前提）");
}

/* ============ H: fs_write_many（一括作成・確認の一本化） ============ */
group("H: fs_write_many / fs_read_many");
{
  const items = [1, 2, 3, 4, 5].map((n) => ({ path: `src/f${n}.ts`, content: `export const v${n} = ${n};\n` }));
  const st = scripted((i) => (i === 0 ? toolJson("fs_write_many", { files: items }) : "土台を作りました。"));
  const { ctx, events, files } = makeCtx({ "package.json": "{}" });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "土台を作って", ctx });
  ok(st.calls === 2, `H1: 一括作成は LLM 1リクエストで完了し、次が最終報告（実際 ${st.calls} 回）`);
  ok([1, 2, 3, 4, 5].every((n) => files()[`src/f${n}.ts`]?.includes(`v${n}`)), "H2: 5ファイルすべて作成された");
  ok(events.filter((e) => e.kind === "change").length === 5, "H3: 変更記録が5件");
  ok(!res.stopped && res.text === "土台を作りました。", "H4: 正常完了");
  // 既存ファイルを含む一括は1回だけ確認し、拒否されたら何も書かない
  let confirms = 0;
  scripted((i) => (i === 0 ? toolJson("fs_write_many", { files: [{ path: "src/App.tsx", content: "new" }, { path: "src/new.ts", content: "n" }] }) : "断念しました。"));
  const c2 = makeCtx({ "src/App.tsx": "orig" }, { confirm: async () => { confirms++; return false; } });
  await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "変えて", ctx: c2.ctx });
  ok(confirms === 1, "H5: 一括の確認は対象をまとめて1回だけ");
  ok(c2.files()["src/App.tsx"] === "orig" && !("src/new.ts" in c2.files()), "H6: 拒否されたら一括すべて実行されない");
  // 純粋関数
  const wm = runFsWriteMany({}, items);
  ok(wm.changes.length === 5 && Object.keys(wm.files).length === 5, "H7: runFsWriteMany が5件の変更を返す");
  const rm = runFsReadMany(wm.files, ["src/f1.ts", "src/f3.ts", "none.ts"]);
  ok(rm.read.length === 2 && rm.missing.length === 1 && rm.output.includes("v1") && rm.output.includes("存在しません"), "H8: runFsReadMany（欠けは例外でなく結果に含める）");
}

/* ============ I: 1応答に複数ツール（配列形式） ============ */
group("I: 複数ツールの一括実行");
{
  const multi = "```json\n" + JSON.stringify([
    { tool: "fs_write", args: { path: "src/x.ts", content: "X" } },
    { tool: "fs_write", args: { path: "src/y.ts", content: "Y" } },
  ]) + "\n```";
  const st = scripted((i) => (i === 0 ? multi : "2ファイル作りました。"));
  const { ctx, events, files } = makeCtx({});
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(st.calls === 2, `I1: 2ツールが LLM 1リクエストで実行された（実際 ${st.calls} 回）`);
  ok(files()["src/x.ts"] === "X" && files()["src/y.ts"] === "Y", "I2: 両方のファイルが作られた");
  ok(events.filter((e) => e.kind === "change").length === 2, "I3: 変更イベント2件");
  ok(!res.stopped && res.text === "2ファイル作りました。", "I4: 正常完了");
  // fs_read_many は「1回の読み取り」として数える（6ファイル読んでも予算に当たらない）
  const many = {};
  for (let n = 1; n <= 6; n++) many[`r${n}.txt`] = `data ${n}`;
  const st2 = scripted((i) => {
    if (i === 0) return toolJson("fs_read_many", { paths: ["r1.txt", "r2.txt", "r3.txt"] });
    if (i === 1) return toolJson("fs_read_many", { paths: ["r4.txt", "r5.txt", "r6.txt"] });
    return "読みました。";
  });
  const c2 = makeCtx(many);
  const r2 = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "読んで", ctx: c2.ctx });
  ok(!r2.stopped && r2.text === "読みました。", "I5: fs_read_many×2（実6ファイル）でも探索上限に当たらない");
  ok(st2.results.some((r) => r.includes("data 1")) && st2.results.some((r) => r.includes("data 6")), "I6: 一括読み取りの結果がモデルに届く");
}

/* ============ J: レート制限（429）で待機して再試行する ============ */
group("J: 429 バックオフ");
{
  DEV_AGENT_BACKOFF.baseMs = 5; // テスト用に待機を短縮（本番は 15s→30s→60s）
  DEV_AGENT_BACKOFF.maxMs = 10;
  let attempts = 0;
  globalThis.__mockLLM = async () => {
    attempts++;
    if (attempts === 1) throw new RateLimitError("利用上限（レート制限）に達しました。対処：少し待って再送してください。", 1);
    if (attempts === 2) return toolJson("fs_write", { path: "src/a.ts", content: "A" });
    return "作成しました。";
  };
  const { ctx, events, files } = makeCtx({});
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(attempts === 3, `J1: 429 の後に同じ手順を再試行した（LLM呼び出し ${attempts} 回）`);
  ok(events.some((e) => e.kind === "note" && e.label.includes("レート制限のため待機中")), "J2: 待機イベントが表示用に発火した");
  ok(files()["src/a.ts"] === "A" && !res.stopped && res.text === "作成しました。", "J3: 待機後に完走する");
  // 待機上限を超えたら正直に停止する
  let attempts2 = 0;
  globalThis.__mockLLM = async () => { attempts2++; throw new RateLimitError("利用上限（レート制限）に達しました。", 1); };
  const c2 = makeCtx({});
  const res2 = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx: c2.ctx });
  ok(!!res2.stopped && res2.stopped.includes("利用上限（レート制限）に繰り返し達したため停止しました"), "J4: 待機上限を超えたら停止メッセージ");
  ok(attempts2 === 1 + DEV_AGENT_BACKOFF.maxWaits, `J5: 初回＋待機${DEV_AGENT_BACKOFF.maxWaits}回で打ち止め（実際 ${attempts2} 回）`);
  DEV_AGENT_BACKOFF.baseMs = 15000;
  DEV_AGENT_BACKOFF.maxMs = 60000;
}

console.log(`\n===== 結果: ${pass} pass / ${fail} fail =====`);
if (failures.length) { console.log("失敗:", failures.join(" / ")); process.exit(1); }
