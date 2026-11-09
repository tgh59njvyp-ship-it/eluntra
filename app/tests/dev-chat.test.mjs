/* Eluntra Developer チャット保存（プロジェクト別）の単体テスト（Node で実行）
   実行: node tests/build-harness.mjs && node tests/dev-chat.test.mjs
   localStorage は chatstore 側のメモリ代替で動く。実ブラウザ保存は画面側で確認する。 */

let bundle;
try {
  bundle = await import("./.bundle.mjs");
} catch {
  console.error("先に node tests/build-harness.mjs を実行してください");
  process.exit(1);
}
const { chatMod } = bundle;
const {
  emptyProjectChat, interleaveChat, splitChatItems, nextChatSeq, trimChat,
  getProjectChat, withProjectChat, withoutProjectChat, chatMessageCount,
  loadChats, saveChats, MAX_CHAT_MESSAGES,
} = chatMod;

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) pass++;
  else { fail++; failures.push(name); console.log("FAIL:", name); }
}
function group(name) { console.log(`\n== ${name} ==`); }

const msg = (seq, content = `m${seq}`) => ({ id: `m${seq}`, role: seq % 2 ? "user" : "assistant", content, seq });
const ev = (seq, label = `e${seq}`) => ({ id: `e${seq}`, kind: "step", label, at: 1000 + seq, seq });

/* ============ A: 保存と読み戻し（プロジェクト別の往復） ============ */
group("A: プロジェクト別チャットの保存・読み戻し");
{
  let chats = {};
  const chatA = { messages: [msg(1, "Aの質問"), msg(2, "Aの回答")], events: [ev(3, "Aの手順")] };
  const chatB = { messages: [msg(1, "Bの質問")], events: [] };
  chats = withProjectChat(chats, "proj-a", chatA);
  chats = withProjectChat(chats, "proj-b", chatB);
  saveChats(chats);
  const loaded = loadChats();
  ok(getProjectChat(loaded, "proj-a").messages.length === 2, "A: proj-a のメッセージが2件戻る");
  ok(getProjectChat(loaded, "proj-a").messages[0].content === "Aの質問", "A: proj-a の内容が一致する");
  ok(getProjectChat(loaded, "proj-b").messages.length === 1, "A: proj-b のメッセージが1件戻る");
  ok(getProjectChat(loaded, "proj-none").messages.length === 0, "A: 未登録プロジェクトは空で戻る");
}

/* ============ B: プロジェクト間の分離 ============ */
group("B: プロジェクト間の分離");
{
  let chats = {};
  chats = withProjectChat(chats, "p1", { messages: [msg(1, "p1だけの内容")], events: [ev(2)] });
  chats = withProjectChat(chats, "p2", { messages: [msg(1, "p2だけの内容")], events: [] });
  const c1 = getProjectChat(chats, "p1");
  const c2 = getProjectChat(chats, "p2");
  ok(c1.messages[0].content === "p1だけの内容" && c2.messages[0].content === "p2だけの内容", "B: 内容が混ざらない");
  ok(c1.events.length === 1 && c2.events.length === 0, "B: イベントも混ざらない");
  // p1 を更新しても p2 は不変
  const chats2 = withProjectChat(chats, "p1", { messages: [msg(1), msg(2), msg(3)], events: [] });
  ok(getProjectChat(chats2, "p2").messages.length === 1, "B: 片方の更新が他方へ影響しない");
  ok(chats !== chats2 && getProjectChat(chats, "p1").messages.length === 1, "B: 元のマップは不変（イミュータブル）");
}

/* ============ C: 削除時のクリーンアップ ============ */
group("C: プロジェクト削除でチャットも消える");
{
  let chats = {};
  chats = withProjectChat(chats, "del", { messages: [msg(1)], events: [] });
  chats = withProjectChat(chats, "keep", { messages: [msg(1)], events: [] });
  const after = withoutProjectChat(chats, "del");
  ok(!("del" in after), "C: 削除したプロジェクトのチャットが消える");
  ok("keep" in after && getProjectChat(after, "keep").messages.length === 1, "C: 他のプロジェクトは残る");
  saveChats(after);
  ok(!("del" in loadChats()), "C: 保存後も消えたまま");
  const same = withoutProjectChat(after, "not-exist");
  ok(same === after, "C: 存在しないIDの削除は同じ参照を返す");
}

/* ============ D: 上限での切り捨て ============ */
group("D: メッセージ上限（最新200件）での切り捨て");
{
  const messages = [];
  const events = [];
  for (let i = 1; i <= 250; i++) messages.push(msg(i, `質問${i}`));
  for (let i = 1; i <= 250; i++) events.push(ev(i + 250));
  const trimmed = trimChat({ messages, events });
  ok(trimmed.messages.length === MAX_CHAT_MESSAGES, `D: メッセージが ${MAX_CHAT_MESSAGES} 件に切り捨てられる`);
  ok(trimmed.messages[0].content === "質問51", "D: 最古の保持メッセージは51件目（最新側が残る）");
  ok(trimmed.messages[trimmed.messages.length - 1].content === "質問250", "D: 最新メッセージが残る");
  ok(trimmed.events.every((e) => e.seq >= trimmed.messages[0].seq), "D: 切り捨て境界より前のイベントは落ちる");
  // withProjectChat（保存経路）でも切り捨てが効く
  const stored = withProjectChat({}, "big", { messages, events });
  ok(getProjectChat(stored, "big").messages.length === MAX_CHAT_MESSAGES, "D: 保存経路でも切り捨てられる");
  // trim=false では切り捨てない（実行中の保存用）
  const raw = withProjectChat({}, "big", { messages, events }, false);
  ok(getProjectChat(raw, "big").messages.length === 250, "D: trim=false では切り捨てない");
  // 上限以下はそのまま
  const small = trimChat({ messages: [msg(1), msg(2)], events: [ev(3)] });
  ok(small.messages.length === 2 && small.events.length === 1, "D: 上限以下は変更されない");
}

/* ============ E: interleave / split の往復と順序 ============ */
group("E: 表示リストとの相互変換");
{
  const chat = {
    messages: [msg(1, "質問"), msg(4, "回答")],
    events: [ev(2, "手順1"), ev(3, "手順2"), ev(5, "手順3")],
  };
  const items = interleaveChat(chat);
  ok(items.length === 5, "E: 全項目が復元される");
  ok(items.map((i) => i.type).join(",") === "msg,event,event,msg,event", "E: seq 順に正しく並ぶ");
  const back = splitChatItems(items);
  ok(back.messages.length === 2 && back.events.length === 3, "E: split で元に戻る");
  ok(back.messages[1].content === "回答" && back.events[2].label === "手順3", "E: split 後も内容と順序が一致");
  ok(nextChatSeq(chat) === 6, "E: 次の seq が最大値+1 になる");
  ok(nextChatSeq(emptyProjectChat()) === 1, "E: 空チャットの次の seq は 1");
  ok(chatMessageCount(chat) === 2 && chatMessageCount(undefined) === 0, "E: メッセージ数が数えられる");
}

console.log(`\n===== 結果: ${pass} pass / ${fail} fail =====`);
if (fail) {
  console.log("失敗:", failures.join(" / "));
  process.exit(1);
}
