/* Eluntra Developer 大きなファイルの分割作成と途中切断サルベージ（v7.2.12）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-salvage.test.mjs
   検証する不具合: 「最後の大きなファイルだけ、再送しても受け取れずに止まる」
   - fs_append で新規作成・追記ができ、変更記録（Undo用）も残る。読み取り専用モードでは拒否される
   - 応答が途中で切れた fs_write は、届いた分を最後の完全な行まで保存し、続きを fs_append で完成させられる
   - fs_write_many は、完全に届いた要素を保存し、切れた要素は途中まで保存して追記で完成させられる
   - 失敗は truncated / parse / nodata に分類され、ノートと停止メッセージに反映される
   - 未完成ファイルがある間は、最終報告で終わらせない
   - パス自体が切れている等、復元できない場合はファイルを作らず正直に止める
   LLM は mock-chat.mjs 経由の台本モデル。実キー・実モデルは使わない。 */

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const { runDevAgent, analyzeToolCalls, salvageTruncatedWrite, fsMod } = bundle;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

const toolJson = (tool, args) => "```json\n" + JSON.stringify({ tool, args }) + "\n```";

function scripted(responder) {
  const state = { calls: 0, snapshots: [] };
  globalThis.__mockLLM = async (history) => {
    state.snapshots.push(history.map((m) => String(m.content)));
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
    sessionFiles: new Set(),
    onEvent: (e) => events.push(e),
  };
  return { ctx, events, files: () => files };
}

const PROVIDER = { id: "mock", kind: "openai" };
const run = (mode, ctx, userText = "作って") =>
  runDevAgent({ provider: PROVIDER, model: "mock", mode, history: [], userText, ctx });

/** n行の大きめのファイル内容を作る（行ごとに一意） */
function bigContent(prefix, n, extraLines = []) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`export const ${prefix}${i} = "value-${prefix}-${i}";`);
  return [...lines.slice(0, 10), ...extraLines, ...lines.slice(10)].join("\n") + "\n";
}

/* ============ A: fs_append の基本動作 ============ */
group("A: fs_append（新規作成・追記・Undo・モード拒否）");
{
  const seq = [
    toolJson("fs_append", { path: "src/a.txt", content: "Hello\n" }),
    toolJson("fs_append", { path: "src/a.txt", content: "World\n" }),
    "追記しました。",
  ];
  scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const c = makeCtx({ "index.html": "<html></html>" });
  const res = await run("build", c.ctx);
  ok(c.files()["src/a.txt"] === "Hello\nWorld\n", "A1: 追記で内容がバイト一致");
  ok(!res.stopped && res.text === "追記しました。", "A2: 正常完了");
  const changes = c.events.filter((e) => e.kind === "change").map((e) => e.change);
  ok(changes.length === 2 && changes[0].kind === "create" && changes[1].kind === "edit", "A3: 変更記録は create → edit");
  ok(changes[1].before === "Hello\n" && changes[1].after === "Hello\nWorld\n", "A4: 追記の before/after が記録される");
  const undone1 = fsMod.revertChange(c.files(), changes[1]);
  ok(undone1["src/a.txt"] === "Hello\n", "A5: 追記の Undo で元の内容に戻る");
  const undone2 = fsMod.revertChange(undone1, changes[0]);
  ok(!("src/a.txt" in undone2), "A6: 作成の Undo でファイルが消える");

  // PLAN（読み取り専用）では拒否される
  const seqP = [toolJson("fs_append", { path: "src/p.txt", content: "x\n" }), "計画をまとめました。"];
  const stP = scripted((i) => seqP[Math.min(i, seqP.length - 1)]);
  const cp = makeCtx({ "index.html": "<html></html>" });
  const resP = await run("plan", cp.ctx);
  ok(!("src/p.txt" in cp.files()), "A7: PLAN では fs_append が実行されない");
  ok(
    stP.snapshots.some((snap) => snap.some((s) => s.includes("変更できません"))),
    "A8: モード拒否の結果がモデルへ返る",
  );
  ok(!resP.stopped && resP.text === "計画をまとめました。", "A9: PLAN は通常完了する");
}

/* ============ B: 途中で切れた fs_write のサルベージ → fs_append で完成 ============ */
group("B: 途中切断のサルベージと追記での完成");
{
  const content = bigContent("line", 40, ['export const esc = "a\\nb";']);
  const fullJson = toolJson("fs_write", { path: "src/big.ts", content });

  // B1: 内容の途中（line25 の途中）で切る
  const cutAt = fullJson.indexOf("line25") + 10;
  const truncated = fullJson.slice(0, cutAt);
  const ana = analyzeToolCalls(truncated);
  ok(ana.calls.length === 0 && ana.failure === "truncated", "B1: 分類は truncated");
  const salv = salvageTruncatedWrite(truncated);
  ok(!!salv && salv.items.length === 1 && salv.items[0].complete === false, "B2: 部分サルベージが取れる");
  ok(
    !!salv && salv.items[0].content.length >= 200 && salv.items[0].content.endsWith("\n") && content.startsWith(salv.items[0].content),
    "B3: 前半は最後の完全な行までの接頭辞",
  );

  const c = makeCtx({ "index.html": "<html></html>" });
  let midState = null;
  const st = scripted((i) => {
    if (i === 0) return truncated;
    if (i === 1) {
      midState = c.files()["src/big.ts"];
      return toolJson("fs_append", { path: "src/big.ts", content: content.slice(midState.length) });
    }
    return "大きなファイルを作成しました。";
  });
  const res = await run("auto", c.ctx, "タイピングサイトの大きいファイルを作って");
  ok(typeof midState === "string" && midState.length >= 200 && content.startsWith(midState), "B4: 実行中は途中まで保存されていた");
  ok(c.files()["src/big.ts"] === content, "B5: 追記で最終ファイルがバイト一致で完成");
  ok(!res.stopped && res.text === "大きなファイルを作成しました。", "B6: 正常完了する");
  ok(
    c.events.some((e) => e.kind === "note" && e.label.includes("途中まで保存")),
    "B7: サルベージのノートがタイムラインに出る",
  );
  ok(
    st.snapshots.some((snap) => snap.some((s) => s.includes("fs_append で送ってください"))),
    "B8: 続きを fs_append で送る指示がモデルに届いた",
  );

  // B2: エスケープの途中で切る（末尾の \ が dangling になる位置）
  const pairIdx = fullJson.indexOf("a\\\\n"); // JSONテキスト中の a\\n（バックスラッシュ2つ＋n）
  ok(pairIdx > 0, "B9: エスケープ位置を特定できた");
  const cutEsc = fullJson.slice(0, pairIdx + 2); // 最初の \ の直後で切る
  const salv2 = salvageTruncatedWrite(cutEsc);
  ok(!!salv2 && salv2.items.length === 1 && salv2.items[0].complete === false, "B10: エスケープ途中の切断でもサルベージできる");
  ok(
    !!salv2 && !salv2.items[0].content.endsWith("\\") && content.startsWith(salv2.items[0].content),
    "B11: 切れたエスケープは残らず、接頭辞として正しい",
  );
  const c2 = makeCtx({ "index.html": "<html></html>" });
  scripted((i) => {
    if (i === 0) return cutEsc;
    if (i === 1) {
      const cur = c2.files()["src/big.ts"] || "";
      return toolJson("fs_append", { path: "src/big.ts", content: content.slice(cur.length) });
    }
    return "完成しました。";
  });
  const res2 = await run("auto", c2.ctx);
  ok(c2.files()["src/big.ts"] === content && !res2.stopped, "B12: エスケープ途中切断でも追記でバイト一致に完成");
}

/* ============ C: fs_write_many の途中切断（完全な要素＋切れた要素） ============ */
group("C: fs_write_many のサルベージ");
{
  const contentA = 'export const a = 1;\n';
  const contentB = 'export const b = 2;\n';
  const contentC = bigContent("cfile", 30);
  const fullJson = toolJson("fs_write_many", {
    files: [
      { path: "src/a.ts", content: contentA },
      { path: "src/b.ts", content: contentB },
      { path: "src/c.ts", content: contentC },
    ],
  });
  const cutAt = fullJson.indexOf("cfile20") + 10;
  const truncated = fullJson.slice(0, cutAt);
  const salv = salvageTruncatedWrite(truncated);
  ok(
    !!salv && salv.items.length === 3 && salv.items[0].complete && salv.items[1].complete && !salv.items[2].complete,
    "C1: 完全な2件＋途中までの1件が復元できる",
  );
  const c = makeCtx({ "index.html": "<html></html>" });
  scripted((i) => {
    if (i === 0) return truncated;
    if (i === 1) {
      const cur = c.files()["src/c.ts"] || "";
      return toolJson("fs_append", { path: "src/c.ts", content: contentC.slice(cur.length) });
    }
    return "3ファイルを作成しました。";
  });
  const res = await run("build", c.ctx);
  ok(c.files()["src/a.ts"] === contentA && c.files()["src/b.ts"] === contentB, "C2: 完全な要素はそのまま保存された");
  ok(c.files()["src/c.ts"] === contentC, "C3: 切れた要素も追記でバイト一致に完成");
  ok(!res.stopped && res.text === "3ファイルを作成しました。", "C4: 正常完了する");
}

/* ============ D: 失敗分類がノートと停止メッセージに反映される ============ */
group("D: 分類（truncated / parse / nodata）");
{
  ok(analyzeToolCalls("こんにちは、質問です").failure === "nodata", "D1: 通常文は nodata");
  const dump = "```ts\n" + Array.from({ length: 35 }, (_, i) => `export const w${i} = ${i};`).join("\n") + "\n```";
  ok(analyzeToolCalls(dump).failure === "nodata", "D2: コードの貼り付けは nodata");
  const parseBad = "```json\n{\"tool\":\"fs_write\",\"args\":{\"path\":\"a.ts\",\"content\":\"x\",,}}\n```";
  ok(analyzeToolCalls(parseBad).failure === "parse", "D3: 閉じているが壊れたJSONは parse");

  // parse が続く → 停止メッセージに分類が出る
  const stParse = scripted(() => parseBad);
  const cParse = makeCtx({ "index.html": "<html></html>" });
  const resParse = await run("build", cParse.ctx);
  ok(!!resParse.stopped && resParse.stopped.includes("形式を読み取れませんでした"), "D4: parse の停止メッセージに分類が出る");
  ok(stParse.calls === 3, "D5: 初回＋修復2回で打ち止め");
  ok(
    cParse.events.some((e) => e.kind === "note" && e.label.includes("形式を読み取れませんでした")),
    "D6: parse のノートにも分類が出る",
  );

  // nodata（コード貼り付け）が続く → 停止メッセージに分類が出る
  scripted(() => dump);
  const cDump = makeCtx({ "index.html": "<html></html>" });
  const resDump = await run("auto", cDump.ctx);
  ok(!!resDump.stopped && resDump.stopped.includes("作成データが含まれていませんでした"), "D7: nodata の停止メッセージに分類が出る");
  ok(!resDump.text.includes("w0"), "D8: 最終文に貼り付けコードが残らない");
}

/* ============ E: 未完成ファイルがある間は最終報告を受け付けない ============ */
group("E: 未完成ガード");
{
  const content = bigContent("guard", 30);
  const fullJson = toolJson("fs_write", { path: "src/g.ts", content });
  const truncated = fullJson.slice(0, fullJson.indexOf("guard18") + 10);
  const c = makeCtx({ "index.html": "<html></html>" });
  const st = scripted((i) => {
    if (i === 0) return truncated;
    if (i === 1) return "完成しました！"; // 追記せずに終わろうとする
    if (i === 2) {
      const cur = c.files()["src/g.ts"] || "";
      return toolJson("fs_append", { path: "src/g.ts", content: content.slice(cur.length) });
    }
    return "完成しました！";
  });
  const res = await run("auto", c.ctx);
  ok(st.calls === 4, `E1: 最終報告が差し戻され、追記の後に受け付けられた（LLM呼び出し ${st.calls} 回）`);
  ok(
    st.snapshots.some((snap) => snap.some((s) => s.includes("未完成です"))),
    "E2: 未完成を伝える継続指示がモデルに届いた",
  );
  ok(c.files()["src/g.ts"] === content, "E3: ファイルは完成している");
  ok(!res.stopped && res.text === "完成しました！", "E4: 完成後の最終報告は受け付けられる");
}

/* ============ F: 復元できない切断（パス自体が切れた） ============ */
group("F: サルベージ不能な切断は、ファイルを作らず正直に止める");
{
  const cutPath = "```json\n{\"tool\":\"fs_write\",\"args\":{\"path\":\"src/typ";
  ok(salvageTruncatedWrite(cutPath) === null, "F1: パスが切れていればサルベージしない");
  ok(analyzeToolCalls(cutPath).failure === "truncated", "F2: 分類は truncated");
  const st = scripted(() => cutPath);
  const c = makeCtx({ "index.html": "<html></html>" });
  const res = await run("auto", c.ctx);
  ok(!("src/typing.ts" in c.files()) && Object.keys(c.files()).length === 1, "F3: 部分ファイルは作られていない");
  ok(!!res.stopped && res.stopped.includes("応答が途中で切れていました"), "F4: 停止メッセージに分類（truncated）が出る");
  ok(st.calls === 3, "F5: 初回＋修復2回で打ち止め");
  ok(
    st.snapshots.some((snap) => snap.some((s) => s.includes("同じ内容を一括で再送しないでください"))),
    "F6: truncated 用の分割指示がモデルに届いた",
  );
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (failures.length) console.log("失敗:\n- " + failures.join("\n- "));
process.exit(fail ? 1 : 0);
