/* Eluntra Developer ツール呼び出し解釈の堅牢化（v7.2.11）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-toolparse.test.mjs
   検証する不具合: 「最後のTypeScriptファイルだけ、コードがチャットに貼られてファイルが作られなかった」
   - ファイル内容に ``` や引用符・バックスラッシュを含む大きな fs_write が正しく解釈される
   - 文字列内の生の改行など、軽く壊れたJSONは修復して取り込む
   - コードの貼り付け（ツール形式でない応答）は最終回答にせず、再送を依頼して回復する
   - 修復が上限を超えたら、コードを流さず正直に止める
   LLM は mock-chat.mjs 経由の台本モデル。実キー・実モデルは使わない。 */

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

/** 台本モデル。responder(callIndex) が次の応答文字列を返す。
    各呼び出し時点の会話（文字列コピー）を state.snapshots に残す */
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
    dbList: async () => "app（SQLite）",
    dbSchema: async () => "テーブル: users(id, name)",
    dbQuery: async (_db, sql) => `query ok: ${sql}`,
    sessionFiles: new Set(),
    onEvent: (e) => events.push(e),
  };
  return { ctx, events, files: () => files };
}

const PROVIDER = { id: "mock", kind: "openai" };
const run = (mode, ctx, userText = "作って") =>
  runDevAgent({ provider: PROVIDER, model: "mock", mode, history: [], userText, ctx });

/* ============ A: 内容に ``` や引用符・バックスラッシュを含む fs_write ============ */
group("A: ファイル内容にフェンスや特殊文字を含む fs_write がバイト一致で保存される");
{
  const trickyLines = [
    'export const MARKER_A = "tricky-a";',
    'const re = /a\\/b"\\\\d+$/g;',
    'const tpl = `sum=${1 + 2} and "quoted"`;',
    'const fence = "```";',
    'const md = ["```ts", "console.log(1)", "```"].join("\\n");',
    'const bs = "C:\\\\temp\\\\x";',
    'export const done = true;',
  ];
  const content = trickyLines.join("\n") + "\n";
  const seq = [toolJson("fs_write", { path: "src/tricky.ts", content }), "作成しました。"];
  scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, files } = makeCtx({ "index.html": "<html></html>" });
  const res = await run("build", ctx, "ファイルを作って");
  ok(files()["src/tricky.ts"] === content, "A1: 内容がバイト一致で保存された");
  ok(!res.stopped && res.text === "作成しました。", "A2: 正常完了し、最終報告はモデルの文章");
}

/* ============ B: 文字列内の生の改行・末尾カンマを含む壊れたJSONを修復する ============ */
group("B: 軽く壊れたツールJSONの修復");
{
  // B1: content 文字列の中に生の改行とタブが入っている（厳密JSONとしては不正）
  const rawReply =
    "```json\n" +
    '{"tool":"fs_write","args":{"path":"src/multi.ts","content":"line1\nline2\tTAB\nline3"}}' +
    "\n```";
  const seq1 = [rawReply, "作成しました。"];
  scripted((i) => seq1[Math.min(i, seq1.length - 1)]);
  const c1 = makeCtx({ "index.html": "<html></html>" });
  const r1 = await run("build", c1.ctx);
  ok(c1.files()["src/multi.ts"] === "line1\nline2\tTAB\nline3", "B1: 生の改行・タブを修復して保存できた");
  ok(!r1.stopped && r1.text === "作成しました。", "B2: 修復後に正常完了");

  // B2: 末尾カンマのあるJSON
  const tcReply = "```json\n" + '{"tool":"fs_write","args":{"path":"src/tc.ts","content":"x",}}' + "\n```";
  const seq2 = [tcReply, "作成しました。"];
  scripted((i) => seq2[Math.min(i, seq2.length - 1)]);
  const c2 = makeCtx({ "index.html": "<html></html>" });
  const r2 = await run("build", c2.ctx);
  ok(c2.files()["src/tc.ts"] === "x", "B3: 末尾カンマを修復して保存できた");
  ok(!r2.stopped, "B4: 末尾カンマでも停止しない");
}

/* ============ C: コードをチャットに貼った応答 → 再送依頼で回復する ============ */
group("C: コードの貼り付けを最終回答にせず、再送で回復する（AUTO）");
{
  const dumpLines = ["// DUMP_MARKER_C", ...Array.from({ length: 34 }, (_, i) => `export const v${i} = ${i};`)];
  const dump = "```ts\n" + dumpLines.join("\n") + "\n```";
  const seq = [
    dump,
    toolJson("fs_write", { path: "src/typing.ts", content: "export const ok = true;\n" }),
    "タイピングサイトを作成しました。",
  ];
  const st = scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, events, files } = makeCtx({ "index.html": "<html></html>" });
  const res = await run("auto", ctx, "タイピングサイトを作って");
  ok(files()["src/typing.ts"] === "export const ok = true;\n", "C1: 再送されたファイルが作成された");
  ok(!res.stopped, "C2: stopped なしで完了");
  ok(res.text === "タイピングサイトを作成しました。", "C3: 最終回答はモデルの報告文");
  ok(!res.text.includes("DUMP_MARKER_C"), "C4: 最終回答に貼り付けコードが含まれない");
  ok(
    st.snapshots.some((snap) => snap.some((c) => c.includes("ツール呼び出しとして解釈できませんでした"))),
    "C5: 再送依頼の指示がモデルに届いた",
  );
  ok(events.some((e) => e.kind === "note" && e.label.includes("再送を依頼")), "C6: 再送依頼のノートがタイムラインに出た");
}

/* ============ D: 壊れたツールJSONが続く → 修復上限で正直に止める ============ */
group("D: 解釈できない応答が続いたら、コードを流さずに停止する");
{
  const broken = "```json\n{\"tool\": \"fs_write\", \"args\": {\"path\": \"src/x.ts\", \"content\": \"BROKEN_MARKER_D abc";
  const st = scripted(() => broken);
  const { ctx, events, files } = makeCtx({ "index.html": "<html></html>" });
  const res = await run("auto", ctx, "ファイルを作って");
  ok(!!res.stopped && res.stopped.includes("保存できていません"), "D1: 正直な停止メッセージが返る");
  ok(!res.text.includes("BROKEN_MARKER_D"), "D2: 最終文にコード（断片）が含まれない");
  ok(!("src/x.ts" in files()), "D3: ファイルは作成されていない");
  ok(st.calls === 3, `D5: 初回＋修復2回で打ち止め（LLM呼び出し ${st.calls} 回）`);
  ok(events.filter((e) => e.kind === "note" && e.label.includes("再送を依頼")).length === 2, "D4: 再送依頼のノートは2回まで");
}

/* ============ E: ASK のコード付き回答は素通しする ============ */
group("E: 読み取り専用モードの最終回答は横取りしない");
{
  const codeLines = Array.from({ length: 35 }, (_, i) => `export const w${i} = ${i};`);
  const answer = "この関数は次のように書けます。\n\n```ts\n" + codeLines.join("\n") + "\n```\n\nポイントは型注釈です。";
  const st = scripted(() => answer);
  const { ctx } = makeCtx({ "index.html": "<html></html>" });
  const res = await run("ask", ctx, "書き方を教えて");
  ok(res.text === answer, "E1: 大きなコードブロック付き回答がそのまま返る");
  ok(!res.stopped, "E2: stopped なし");
  ok(st.calls === 1, "E3: 再送依頼は発生しない（LLM呼び出し1回）");
}

/* ============ F: BUILD の通常の最終報告（短いコード付き）は素通しする ============ */
group("F: 書き込み系モードでも、短いコード例を含む報告は最終回答として通す");
{
  const report = "作成しました。使い方は次のとおりです。\n\n```ts\nimport { ok } from \"./typing\";\nconsole.log(ok);\n```";
  const seq = [toolJson("fs_write", { path: "src/typing.ts", content: "export const ok = true;\n" }), report];
  scripted((i) => seq[Math.min(i, seq.length - 1)]);
  const { ctx, files } = makeCtx({ "index.html": "<html></html>" });
  const res = await run("build", ctx, "作って");
  ok(files()["src/typing.ts"] === "export const ok = true;\n", "F1: ファイルは作成された");
  ok(!res.stopped && res.text === report, "F2: 短いコード付きの報告がそのまま最終回答になる");
}

console.log(`\n結果: ${pass} passed, ${fail} failed`);
if (failures.length) console.log("失敗:\n- " + failures.join("\n- "));
process.exit(fail ? 1 : 0);
