/*
 * データの引き継ぎ（URL統合に伴う SUS オリジン → Vercel オリジンの移行）
 *
 * 送信側（以前のURLで動くこのアプリ自身、または移行後も残すスタブ）:
 *   ?migrate_export=1 かつ iframe 内で開かれた場合にだけ、localStorage の
 *   eluntra_* キーを丸ごと親フレームへ postMessage する。宛先オリジンは
 *   本番では https://eluntra.vercel.app に厳密に限定する。
 * 受信側（eluntra.vercel.app の設定画面）:
 *   以前のURLを iframe で読み込み、origin を厳密に検証したうえで受け取り、
 *   件数の確認を挟んでから localStorage へ書き込む。
 * データがサーバーを経由することは一切ない（ブラウザ同士の直接受け渡し）。
 */

export const CANONICAL_ORIGIN = "https://eluntra.vercel.app";
export const LEGACY_ORIGIN = "https://simple-url-server.lovable.app";
export const LEGACY_BASE = "https://simple-url-server.lovable.app/s/eluntra/";
export const EXPORT_MESSAGE_TYPE = "eluntra-export-v1";
const DONE_FLAG = "eluntra_migrated_done";

export function isDevHost(): boolean {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

/** 引き継ぎ元（iframe に読み込むURLのベース）。開発時のみ ?migrate_from= で差し替え可能 */
export function legacyBase(): string {
  if (isDevHost()) {
    try {
      const over = new URL(location.href).searchParams.get("migrate_from");
      if (over) return over.endsWith("/") ? over : over + "/";
    } catch {
      /* ignore */
    }
  }
  return LEGACY_BASE;
}

/** 引き継ぎ元のオリジン（受信時の検証用）。開発時は差し替え先のオリジン */
export function legacyOrigin(): string {
  if (isDevHost()) {
    try {
      return new URL(legacyBase()).origin;
    } catch {
      return LEGACY_ORIGIN;
    }
  }
  return LEGACY_ORIGIN;
}

/** localStorage の eluntra_* を生文字列のまま集める */
export function collectExportData(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("eluntra_")) continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 送信側として起動すべきかを判定し、該当すればデータを親へ送る。
 * 送った場合は true（呼び出し側はアプリ本体を描画せずプレースホルダを出す）。
 */
export function tryRunExporter(): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(location.href).searchParams;
  } catch {
    return false;
  }
  if (params.get("migrate_export") !== "1") return false;
  if (window.parent === window) return false;
  let parentOrigin = "";
  try {
    parentOrigin = location.ancestorOrigins?.[0] ?? "";
  } catch {
    parentOrigin = "";
  }
  let target = "";
  if (parentOrigin === CANONICAL_ORIGIN) {
    target = CANONICAL_ORIGIN;
  } else if (isDevHost() && parentOrigin) {
    /* ローカル検証用：localhost 同士でのみ任意の親オリジンを許可 */
    target = parentOrigin;
  } else {
    return false;
  }
  const data = collectExportData();
  window.parent.postMessage({ type: EXPORT_MESSAGE_TYPE, data }, target);
  return true;
}

export interface ExportSummary {
  keyCount: number;
  sessionCount: number;
  customCount: number;
  connectorCount: number;
  totalKeys: number;
}

function countObject(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const j = JSON.parse(raw) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? Object.keys(j).length : 0;
  } catch {
    return 0;
  }
}

function countArray(raw: string | undefined): number {
  if (!raw) return 0;
  try {
    const j = JSON.parse(raw) as unknown;
    return Array.isArray(j) ? j.length : 0;
  } catch {
    return 0;
  }
}

/** 確認画面用に、受け取ったデータの内訳を数える */
export function summarizeExport(data: Record<string, string>): ExportSummary {
  return {
    keyCount: countObject(data["eluntra_keys"]),
    sessionCount: countArray(data["eluntra_sessions"]),
    customCount: countArray(data["eluntra_customs"]),
    connectorCount: countObject(data["eluntra_connectors"]),
    totalKeys: Object.keys(data).length,
  };
}

/** 受け取ったデータを localStorage へ書き込む（同名キーは引き継ぎ側が優先、無いものは残す） */
export function applyImport(data: Record<string, string>): void {
  Object.entries(data).forEach(([k, v]) => {
    if (!k.startsWith("eluntra_")) return;
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 容量超過などは個別に無視 */
    }
  });
  try {
    sessionStorage.setItem(DONE_FLAG, "1");
  } catch {
    /* ignore */
  }
}

/** リロード後に一度だけ「引き継ぎ完了」を知らせるためのフラグ確認 */
export function consumeMigratedFlag(): boolean {
  try {
    if (sessionStorage.getItem(DONE_FLAG) === "1") {
      sessionStorage.removeItem(DONE_FLAG);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}
