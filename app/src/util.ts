/** 小物ユーティリティ（DOM取得・エスケープ・トースト） */

export function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`要素が見つかりません: ${sel}`);
  return el as T;
}

export function esc(s: unknown): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return String(s ?? "").replace(/[&<>"']/g, (c) => map[c] ?? c);
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

let toastTimer: number | undefined;
export function toast(msg: string): void {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove("on"), 2600);
}
