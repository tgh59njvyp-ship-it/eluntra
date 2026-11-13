/* Playgrounds: AIチャットのプロジェクト別保存（純粋関数層）
   DOM・Reactに依存しない。単体テスト（node）から直接駆動できる。
   チャットはプロジェクトごとに分け、eluntra_dev_chats（localStorage）へ
   { [projectId]: { messages, events } } の形で保存する。
   messages / events は seq（会話内の通し番号）で元の並び順に復元する。 */

import type { ChangeRecord } from "./agent";

/** チャットの1メッセージ（利用者／AI／案内） */
export interface DevChatMsg {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** 会話内での通し番号（メッセージとイベントの前後関係を保つ） */
  seq: number;
}

/** チャットの1イベント（ツール実行・変更カード・手順表示） */
export interface DevChatEvent {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  output?: string;
  change?: ChangeRecord;
  step?: number;
  max?: number;
  at: number;
  seq: number;
}

export interface ProjectChat {
  messages: DevChatMsg[];
  events: DevChatEvent[];
}

export type DevChats = Record<string, ProjectChat>;

/** 描画側で使う並び替え済みの1項目 */
export type DevChatItem = { type: "msg"; msg: DevChatMsg } | { type: "event"; event: DevChatEvent };

export const DEV_CHATS_LS = "eluntra_dev_chats";
/** 容量保護: プロジェクトごとに保持するメッセージの上限 */
export const MAX_CHAT_MESSAGES = 200;
/** 容量保護: イベントの保持上限（メッセージ上限とは別に数える） */
export const MAX_CHAT_EVENTS = 600;

export function emptyProjectChat(): ProjectChat {
  return { messages: [], events: [] };
}

/** { messages, events } を seq 順の表示用リストへ復元する */
export function interleaveChat(chat: ProjectChat): DevChatItem[] {
  const msgs = [...(chat.messages || [])].sort((a, b) => a.seq - b.seq);
  const evs = [...(chat.events || [])].sort((a, b) => a.seq - b.seq);
  const out: DevChatItem[] = [];
  let i = 0;
  let j = 0;
  while (i < msgs.length || j < evs.length) {
    if (j >= evs.length || (i < msgs.length && msgs[i].seq <= evs[j].seq)) {
      out.push({ type: "msg", msg: msgs[i] });
      i++;
    } else {
      out.push({ type: "event", event: evs[j] });
      j++;
    }
  }
  return out;
}

/** 表示用リストを保存形 { messages, events } へ分ける */
export function splitChatItems(items: DevChatItem[]): ProjectChat {
  const messages: DevChatMsg[] = [];
  const events: DevChatEvent[] = [];
  for (const it of items) {
    if (it.type === "msg") messages.push(it.msg);
    else events.push(it.event);
  }
  return { messages, events };
}

/** 次に使う seq（既存の最大値 + 1） */
export function nextChatSeq(chat: ProjectChat): number {
  let max = 0;
  for (const m of chat.messages || []) if (m.seq > max) max = m.seq;
  for (const e of chat.events || []) if (e.seq > max) max = e.seq;
  return max + 1;
}

/**
 * 容量保護のための切り捨て。メッセージは新しい順に最大 maxMessages 件を残し、
 * 残した最古のメッセージより前のイベントは会話ごと落とす。
 * 実行中は呼び出さないこと（呼び出し側で制御する）。
 */
export function trimChat(chat: ProjectChat, maxMessages = MAX_CHAT_MESSAGES, maxEvents = MAX_CHAT_EVENTS): ProjectChat {
  const messages = [...(chat.messages || [])].sort((a, b) => a.seq - b.seq);
  const events = [...(chat.events || [])].sort((a, b) => a.seq - b.seq);
  const keptMsgs = messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages;
  let keptEvents = events;
  if (keptMsgs.length > 0 && messages.length > keptMsgs.length) {
    const floor = keptMsgs[0].seq;
    keptEvents = keptEvents.filter((e) => e.seq >= floor);
  }
  if (keptEvents.length > maxEvents) keptEvents = keptEvents.slice(keptEvents.length - maxEvents);
  return { messages: keptMsgs, events: keptEvents };
}

/** プロジェクトのチャットを取り出す（無ければ空） */
export function getProjectChat(chats: DevChats, projectId: string): ProjectChat {
  const c = chats[projectId];
  if (!c) return emptyProjectChat();
  return { messages: c.messages || [], events: c.events || [] };
}

/** チャットを差し替えた新しいマップを返す（保存時に切り捨てを適用） */
export function withProjectChat(chats: DevChats, projectId: string, chat: ProjectChat, trim = true): DevChats {
  return { ...chats, [projectId]: trim ? trimChat(chat) : chat };
}

/** プロジェクト削除に合わせてチャットも消した新しいマップを返す */
export function withoutProjectChat(chats: DevChats, projectId: string): DevChats {
  if (!(projectId in chats)) return chats;
  const next = { ...chats };
  delete next[projectId];
  return next;
}

/** ダッシュボード表示用: そのプロジェクトのメッセージ数 */
export function chatMessageCount(chat: ProjectChat | undefined): number {
  return chat?.messages?.length || 0;
}

/* ---------- 永続化（localStorage。node環境ではメモリ代替） ---------- */

let memFallback: DevChats | null = null;

export function loadChats(): DevChats {
  try {
    const raw = localStorage.getItem(DEV_CHATS_LS);
    if (!raw) return {};
    const obj = JSON.parse(raw) as DevChats;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
    const out: DevChats = {};
    for (const [id, c] of Object.entries(obj)) {
      if (c && typeof c === "object") {
        out[id] = {
          messages: Array.isArray(c.messages) ? c.messages : [],
          events: Array.isArray(c.events) ? c.events : [],
        };
      }
    }
    return out;
  } catch {
    return memFallback || {};
  }
}

export function saveChats(chats: DevChats): void {
  memFallback = chats;
  try {
    localStorage.setItem(DEV_CHATS_LS, JSON.stringify(chats));
  } catch {
    /* 容量超過などは無視（メモリ上は保持） */
  }
}
