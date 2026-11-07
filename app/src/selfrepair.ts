import { callChat } from "./api";
import { PROVIDERS } from "./providers";
import { renderChat, renderSessions } from "./render";
import { load, persistConf, persistSessions, save, state } from "./state";
import { $, esc, toast } from "./util";

/**
 * サイト自己修復。
 * サイト自身のエラーを記録し、保存済みのGeminiキーでAIに診断させ、
 * 許可リスト内の安全な修復操作だけを実行する。APIキーは絶対に消さない。
 */

export interface ErrorEntry {
  t: number;
  msg: string;
  src: string;
  count: number;
}

const ERR_KEY = "eluntra_error_log";
const REPAIR_KEY = "eluntra_repair_log";
const AUTO_KEY = "eluntra_autorepair";
const BACKUP_KEY = "eluntra_backup_sessions";

export function getErrors(): ErrorEntry[] {
  return load<ErrorEntry[]>(ERR_KEY, []);
}

export function getRepairLog(): string[] {
  return load<string[]>(REPAIR_KEY, []);
}

export function autoRepairEnabled(): boolean {
  return load<boolean>(AUTO_KEY, true);
}

export function setAutoRepair(v: boolean): void {
  save(AUTO_KEY, v);
}

function pushRepairLog(line: string): void {
  const log = getRepairLog();
  log.unshift(new Date().toLocaleString("ja-JP") + "　" + line);
  save(REPAIR_KEY, log.slice(0, 30));
  renderRepairPanel();
}

/* ---------- 監視 ---------- */

let toastAt = 0;
let errorsThisSession = 0;
let autoRunning = false;

export function recordError(msg: string, src: string): void {
  const clean = String(msg || "不明なエラー").slice(0, 300);
  const errs = getErrors();
  const found = errs.find((e) => e.msg === clean);
  if (found) {
    found.count++;
    found.t = Date.now();
  } else {
    errs.unshift({ t: Date.now(), msg: clean, src, count: 1 });
  }
  save(ERR_KEY, errs.slice(0, 50));
  errorsThisSession++;
  renderRepairPanel();
  const now = Date.now();
  if (now - toastAt > 8000) {
    toastAt = now;
    toast("エラーが発生したため記録しました。設定の「自己修復」でAIが直せます。");
  }
  if (autoRepairEnabled() && errorsThisSession >= 2 && !autoRunning) {
    void runSelfRepair(true);
  }
}

export function installWatchdog(): void {
  window.addEventListener("error", (e) => {
    if (e.message) recordError(e.message, "window");
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    recordError(r instanceof Error ? r.message : String(r), "promise");
  });
}

/* ---------- 修復操作（許可リスト） ---------- */

interface RepairAction {
  type: string;
  key?: string;
  index?: number;
}

function applyAction(a: RepairAction): string {
  switch (a.type) {
    case "backup_sessions": {
      save(BACKUP_KEY, state.sessions);
      return "会話のバックアップを作成しました";
    }
    case "drop_session": {
      const i = typeof a.index === "number" ? a.index : -1;
      if (i < 0 || i >= state.sessions.length) return "会話の削除は対象が無いため見送りました";
      const title = state.sessions[i].title || "無題";
      state.sessions.splice(i, 1);
      persistSessions();
      renderSessions();
      renderChat();
      return `壊れている会話「${title}」を削除しました`;
    }
    case "clear_key": {
      const key = String(a.key || "");
      if (!key.startsWith("eluntra_") || key === "eluntra_keys" || key === ERR_KEY) {
        return "保存データの消去は安全のため見送りました";
      }
      localStorage.removeItem(key);
      if (key === "eluntra_sessions") {
        state.sessions = [];
        persistSessions();
        renderSessions();
        renderChat();
      }
      return `保存データ ${key} を消去しました`;
    }
    case "reset_conf": {
      state.conf.system = "";
      state.conf.temp = 0.7;
      state.conf.agent = false;
      state.conf.mode = "chat";
      persistConf();
      return "設定（システムプロンプト等）を初期化しました（キーは保持）";
    }
    case "reload":
      return "再読み込みします";
    default:
      return "対処不要と判断されました";
  }
}

/* ---------- AI診断・修復 ---------- */

export async function runSelfRepair(auto = false): Promise<void> {
  if (autoRunning) return;
  const errs = getErrors();
  if (!errs.length) {
    if (!auto) toast("エラー記録はありません");
    return;
  }
  const gemini = PROVIDERS.find((p) => p.id === "gemini");
  const key = gemini ? (state.keys.gemini || "").trim() : "";
  if (!gemini || !key) {
    pushRepairLog("修復できませんでした：GeminiのAPIキーが未設定です。設定でGeminiキーを保存すると、AIが自動修復できるようになります。");
    if (!auto) toast("Geminiのキーを設定すると、AIが自動修復できます");
    return;
  }
  autoRunning = true;
  setRepairBusy(true);
  try {
    const model = state.conf.models.gemini || gemini.def;
    const summary = {
      errors: errs.slice(0, 8),
      sessionCount: state.sessions.length,
      sessionTitles: state.sessions.slice(0, 10).map((s) => s.title),
      provider: state.conf.provider,
      mode: state.conf.mode,
      storageKeys: Object.keys(localStorage).filter((k) => k.startsWith("eluntra_")),
    };
    const prompt =
      "あなたはWebアプリ「Eluntra」の自己修復AIです。次のエラー記録と状態を見て、原因を診断し、必要な修復操作だけを選んでください。\n" +
      "出力はJSONだけにしてください：{\"diagnosis\":\"日本語で簡潔に\",\"actions\":[...]}\n" +
      "使える操作は次の5種だけです。\n" +
      "- {\"type\":\"backup_sessions\"} 会話のバックアップを作る\n" +
      "- {\"type\":\"drop_session\",\"index\":数値} 壊れている会話を削除する（sessionTitlesの順番のindex）\n" +
      "- {\"type\":\"clear_key\",\"key\":\"eluntra_で始まるキー名\"} 保存データを消去する（eluntra_keysは絶対禁止）\n" +
      "- {\"type\":\"reset_conf\"} 設定を初期化する（キーは保持される）\n" +
      "- {\"type\":\"reload\"} ページを再読み込みする\n" +
      "対処が不要なら actions は空配列にしてください。状態が壊れていそうな場合は、最初に backup_sessions を入れてください。\n\n" +
      JSON.stringify(summary);
    const raw = await callChat(gemini, key, model, [{ role: "user", content: prompt }], () => undefined);
    const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
    if (!jsonText) throw new Error("AIの回答を読み取れませんでした");
    const parsed = JSON.parse(jsonText) as { diagnosis?: string; actions?: RepairAction[] };
    pushRepairLog("診断：" + String(parsed.diagnosis || "（診断文なし）"));
    const actions = Array.isArray(parsed.actions) ? parsed.actions.slice(0, 5) : [];
    let needReload = false;
    for (const a of actions) {
      if (!a || typeof a.type !== "string") continue;
      const result = applyAction(a);
      pushRepairLog("修復：" + result);
      if (a.type === "reload") needReload = true;
    }
    if (actions.length) {
      save(ERR_KEY, []);
      errorsThisSession = 0;
      toast("AIがサイトを修復しました");
    } else {
      toast("AI診断の結果、修復操作は不要でした");
    }
    renderRepairPanel();
    if (needReload) window.setTimeout(() => location.reload(), 900);
  } catch (e) {
    pushRepairLog("修復に失敗しました：" + (e instanceof Error ? e.message : String(e)));
    if (!auto) toast("修復できませんでした。設定の自己修復に記録があります");
  } finally {
    autoRunning = false;
    setRepairBusy(false);
    renderRepairPanel();
  }
}

/* ---------- 設定パネル ---------- */

function setRepairBusy(busy: boolean): void {
  const btn = document.querySelector<HTMLButtonElement>("#btnSelfRepair");
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy ? "AIが診断・修復中…" : "AIで診断・修復する";
  }
}

export function renderRepairPanel(): void {
  const status = document.querySelector<HTMLElement>("#repairStatus");
  if (!status) return;
  const errs = getErrors();
  status.textContent = errs.length
    ? `エラー記録：${errs.length}件（最新：${errs[0].msg}）`
    : "エラー記録はありません。";
  const logBox = document.querySelector<HTMLElement>("#repairLog");
  if (logBox) {
    logBox.innerHTML = getRepairLog()
      .slice(0, 8)
      .map((l) => `<div>${esc(l)}</div>`)
      .join("");
  }
  const chk = document.querySelector<HTMLInputElement>("#chkAutoRepair");
  if (chk) chk.checked = autoRepairEnabled();
}

export function copyRepairLog(): void {
  const data = JSON.stringify({ errors: getErrors(), repairLog: getRepairLog() }, null, 2);
  void navigator.clipboard
    .writeText(data)
    .then(() => toast("エラー記録と修復ログをコピーしました"))
    .catch(() => toast("コピーできませんでした"));
}
