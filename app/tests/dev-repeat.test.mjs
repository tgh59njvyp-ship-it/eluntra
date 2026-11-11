/* Eluntra Developer 同一処理の再実行防止（v7.2.13）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-repeat.test.mjs
   検証する不具合: 「デベロッパーが同じ処理ばかり繰り返して、止めてくる」
   - ファイルが変わっていない同一呼び出しは再実行せず、前回の結果を返して次へ促す
   - ファイルが変わった後の同一呼び出し（修正後のビルド再確認など）は新規に実行する
   - 同じ内容の fs_write / fs_append / fs_write_many は冪等に扱い、二重適用しない
   - 繰り返しだけで前進しない実行は、従来どおり停滞検出で正直に止まる（安全弁）
   LLM は mock-chat.mjs 経由の台本モデル。実キー・実モデルは使わない。 */

import { readFileSync } from "node:fs";

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const { runDevAgent } = bundle;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";
const toolJsonMany = (calls) => "```json\n" + JSON.stringify(calls.map(([tool, args]) => ({ tool, args }))) + "\n```";

/** 台本モデル。responder(callIndex) が次の応答文字列を返す。モデルへ渡った結果も集める */
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
const changeCount = (events) => events.filter((e) => e.kind === "change").length;

/* ============ (a) 同じ term_exec を連続実行しない ============ */
group("(a) ファイル変更なしの同一 term_exec は1回だけ実行し、前回の結果を返す");
{
  let termCalls = 0;
  const st = scripted((i) => {
    if (i === 0) return toolJson("term_exec", { command: "npm run build" });
    if (i === 1) return toolJson("term_exec", { command: "npm run build" });
    return "ビルド確認が取れたので完了します。";
  });
  const { ctx, events } = makeCtx({}, {
    termExec: async (cmd) => { termCalls++; return `$ ${cmd}\nbuild ok`; },
  });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(termCalls === 1, "a1: termExec の実実行は1回だけ");
  ok(!res.stopped, "a2: 停止せず通常終了する");
  ok(res.text.includes("完了します"), "a3: 最終報告が返る");
  ok(st.results.length >= 2 && st.results[1].includes("再実行しませんでした"), "a4: 2回目には再実行省略の通知と前回結果が返る");
  ok(st.results.length >= 2 && st.results[1].includes("build ok"), "a5: 前回の結果そのものが含まれている");
  ok(events.some((e) => e.kind === "note" && String(e.label || "").includes("再実行を省略")), "a6: タイムラインに再実行省略の表示が出る");
}

/* ============ (a2) 同一手順内の重複も実行しない ============ */
group("(a2) 1つの応答に同じ term_exec が2つあっても実行は1回");
{
  let termCalls = 0;
  const st = scripted((i) => {
    if (i === 0) return toolJsonMany([["term_exec", { command: "npm test" }], ["term_exec", { command: "npm test" }]]);
    return "テスト確認まで完了しました。";
  });
  const { ctx } = makeCtx({}, {
    termExec: async (cmd) => { termCalls++; return `$ ${cmd}\nall tests passed`; },
  });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(termCalls === 1, "a2-1: 同一手順内の重複も実実行は1回");
  ok(!res.stopped && res.text.includes("完了"), "a2-2: 通常終了する");
  ok(st.results.length >= 1 && (st.results[0].match(/再実行しませんでした/g) || []).length === 1, "a2-3: 2件目の結果だけが省略通知になる");
}

/* ============ (b) ファイル変更後の同一 term_exec は再実行する ============ */
group("(b) 修正を入れた後の同じビルド確認は、新規に実行される");
{
  let termCalls = 0;
  const st = scripted((i) => {
    if (i === 0) return toolJson("term_exec", { command: "npm run build" });
    if (i === 1) return toolJson("fs_edit", { path: "src/a.ts", old: "x = 1", new: "x = 2" });
    if (i === 2) return toolJson("term_exec", { command: "npm run build" });
    return "修正と再確認が完了しました。";
  });
  const { ctx, files } = makeCtx({ "src/a.ts": "export const x = 1;\n" }, {
    termExec: async (cmd) => { termCalls++; return `$ ${cmd}\nbuild ok #${termCalls}`; },
  });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "直して", ctx });
  ok(termCalls === 2, "b1: ファイル変更を挟んだ同一コマンドは2回実行される");
  ok(files()["src/a.ts"] === "export const x = 2;\n", "b2: 編集が適用されている");
  ok(st.results.length >= 3 && st.results[2].includes("build ok #2"), "b3: 2回目は新しい実行結果が返る");
  ok(st.results.length >= 3 && !st.results[2].includes("再実行しませんでした"), "b4: 2回目に省略通知は付かない");
  ok(!res.stopped, "b5: 停止しない");
}

/* ============ (c) 同じ内容の fs_write は二重に記録しない ============ */
group("(c) 同一内容の fs_write 再送は保存済みとして扱い、変更記録は1件だけ");
{
  const content = "export const a = 1;\n";
  const st = scripted((i) => {
    if (i === 0) return toolJson("fs_write", { path: "src/a.ts", content });
    if (i === 1) return toolJson("fs_write", { path: "src/a.ts", content });
    return "ファイルを作成しました。";
  });
  const { ctx, events, files } = makeCtx({});
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(changeCount(events) === 1, "c1: 変更記録は1件だけ");
  ok(files()["src/a.ts"] === content, "c2: ファイル内容は正しい");
  ok(st.results.length >= 2 && st.results[1].includes("すでに同じ内容で保存済みです"), "c3: 2回目には保存済みの通知が返る");
  ok(!res.stopped, "c4: 停止しない");
}

/* ============ (c2) fs_write_many の同一アイテムだけをスキップする ============ */
group("(c2) fs_write_many では同一内容のアイテムだけがスキップされ、他は書かれる");
{
  scripted((i) => {
    if (i === 0) return toolJson("fs_write_many", { files: [
      { path: "src/existing.ts", content: "same\n" },
      { path: "src/new.ts", content: "new\n" },
    ] });
    return "まとめて作成しました。";
  });
  const { ctx, events, files } = makeCtx({ "src/existing.ts": "same\n" });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(changeCount(events) === 1, "c2-1: 変更記録は新規ファイルの1件だけ");
  ok(files()["src/existing.ts"] === "same\n" && files()["src/new.ts"] === "new\n", "c2-2: 両ファイルの内容が正しい");
  ok(!res.stopped, "c2-3: 停止しない");
}

/* ============ (d) 同じ fs_append は二重に追記しない ============ */
group("(d) 同一の fs_append 再送では内容が二重化しない");
{
  const st = scripted((i) => {
    if (i === 0) return toolJson("fs_append", { path: "src/data.txt", content: "chunk-1\n" });
    if (i === 1) return toolJson("fs_append", { path: "src/data.txt", content: "chunk-1\n" });
    return "追記しました。";
  });
  const { ctx, events, files } = makeCtx({});
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(files()["src/data.txt"] === "chunk-1\n", "d1: 追記は1回分だけ（内容が二重化していない）");
  ok(changeCount(events) === 1, "d2: 変更記録は1件だけ");
  ok(st.results.length >= 2 && st.results[1].includes("既に適用済みのため再実行しませんでした"), "d3: 2回目には適用済みで省略した通知が返る");
  ok(!res.stopped, "d4: 停止しない");
}

/* ============ (d2) 末尾が変わっていれば同じ追記でも実行する ============ */
group("(d2) ファイル末尾が変わった後の同じ fs_append は、新規に実行される");
{
  scripted((i) => {
    if (i === 0) return toolJson("fs_append", { path: "src/f.txt", content: "tail\n" });
    if (i === 1) return toolJson("fs_edit", { path: "src/f.txt", old: "tail", new: "end" });
    if (i === 2) return toolJson("fs_append", { path: "src/f.txt", content: "tail\n" });
    return "完了しました。";
  });
  const { ctx, files } = makeCtx({ "src/f.txt": "start\n" });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(files()["src/f.txt"] === "start\nend\ntail\n", "d2-1: 末尾が変わっていれば同じ追記でも実行される");
  ok(!res.stopped, "d2-2: 停止しない");
}

/* ============ (e) 繰り返しだけの実行は停滞検出で正直に止まる ============ */
group("(e) 同じ呼び出しだけを繰り返すモデルは、停滞検出で止まる（安全弁）");
{
  let termCalls = 0;
  scripted(() => toolJson("term_exec", { command: "npm run build" }));
  const { ctx } = makeCtx({}, {
    termExec: async (cmd) => { termCalls++; return `$ ${cmd}\nbuild ok`; },
  });
  const res = await runDevAgent({ provider: PROVIDER, model: "mock", mode: "build", history: [], userText: "作って", ctx });
  ok(termCalls === 1, "e1: 実実行は最初の1回だけ（残りは省略）");
  ok(!!res.stopped, "e2: 前進しないので停止はする");
  ok(!!res.stopped && res.stopped.includes("作業が前に進まなくなったため"), "e3: 停止理由は停滞検出の文面");
  ok(!!res.stopped && !res.stopped.includes("同じツール呼び出し"), "e4: 旧来の同一呼び出し停止の文面ではない");
  const src = readFileSync(new URL("../src/developer/agent.ts", import.meta.url), "utf8");
  ok(!src.includes("同じツール呼び出し（"), "e5: ソースから旧来の同一呼び出し停止が除去されている");
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("失敗:", failures.join(" / "));
  process.exit(1);
}
