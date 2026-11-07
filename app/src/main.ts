import "./styles.css";
import {
  handleAuthCallback,
  isLoggedIn,
  loginWith,
  logout,
  onAuthChange,
  pullSync,
  pushSync,
  type OAuthProvider,
} from "./auth";
import { runAgent } from "./agent";
import { initCodeUI, verifyAndRepair } from "./code";
import { copyRepairLog, installWatchdog, renderRepairPanel, runSelfRepair, setAutoRepair } from "./selfrepair";
import { callChat, fetchModels, testConnection } from "./api";
import { logoTile } from "./logos";
import { PROVIDERS, findProvider } from "./providers";
import {
  SUGGESTIONS,
  applyTheme,
  closeSheet,
  closeSidebar,
  currentTheme,
  openModelSheet,
  openSettings,
  openSheet,
  openSidebar,
  renderAccount,
  renderAll,
  renderModelSheet,
  renderSettings,
  scrollBottom,
  renderNotes,
} from "./render";
import { md } from "./markdown";
import {
  createSession,
  curModel,
  curProv,
  curSession,
  deleteSession,
  ensureSession,
  load,
  persistConf,
  joinSavedKey,
  persistKeys,
  persistNotes,
  persistSessions,
  splitSavedKey,
  persistTested,
  resetAllData,
  runtime,
  state,
} from "./state";
import type { Message, Provider, Session } from "./types";
import { $, esc, toast } from "./util";

/* バナー内のボタンから呼べるよう公開する */
(window as unknown as { openSettings: typeof openSettings }).openSettings = openSettings;

/* ---------- 送信フロー ---------- */

function setSendBtn(stop: boolean): void {
  const b = $("#btnSend");
  if (stop) {
    b.classList.add("stop");
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" style="stroke:#fff"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>';
    b.setAttribute("aria-label", "停止");
  } else {
    b.classList.remove("stop");
    b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" style="stroke:var(--accent-ink)"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    b.setAttribute("aria-label", "送信");
  }
}

/* ---------- モデル自動取得 ----------
   キーがある会社は、起動時・切替時・モデル画面を開いた時に裏で一覧を取りにいく。
   取得済みなら再取得しない（キー保存時は新しいキーで取り直す）。失敗しても静かに既定一覧のままにする。 */
const autoFetchTried = new Set<string>();

async function autoFetchModels(pid: string, force = false): Promise<void> {
  const key = (state.keys[pid] || "").trim();
  if (!key) return;
  if (!force && state.fetchedModels[pid]?.length) return;
  if (autoFetchTried.has(pid) && !force) return;
  autoFetchTried.add(pid);
  try {
    await fetchModels(pid);
    renderAll();
    if (document.querySelector("#modelSheet.on")) {
      renderModelSheet(($("#modelSearch") as HTMLInputElement).value);
    }
  } catch {
    /* 自動取得の失敗は静かに扱う（手動の「一覧を取得」で再試行できる） */
  }
}

function updateStreamingMsg(s: Session, aiMsg: Message): void {
  const col = $("#chatCol");
  const nodes = col.querySelectorAll(".msg");
  const idx = s.messages.indexOf(aiMsg);
  const node = nodes[idx];
  if (!node) {
    renderAll();
    return;
  }
  const body = node.querySelector(".msg-body");
  if (body) body.innerHTML = md(aiMsg.content);
  if (aiMsg.steps && aiMsg.steps.length) {
    const html = aiMsg.steps.map((st) => `<div class="step"><svg class="ic sm" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span>${esc(st)}</span></div>`).join("");
    let box = node.querySelector(".msg-steps");
    if (!box) {
      box = document.createElement("div");
      box.className = "msg-steps";
      node.insertBefore(box, body);
    }
    box.innerHTML = html;
  }
  scrollBottom(true);
}

function renderChatWithNoKey(p: Provider): void {
  renderAll();
  const col = $("#chatCol");
  const div = document.createElement("div");
  div.className = "banner";
  div.innerHTML =
    '<svg class="ic" viewBox="0 0 24 24"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg><div><b>' +
    esc(p.name) +
    'のAPIキーが未設定です。</b><br>対処：設定を開いてキーを貼り、「接続テスト」で確認してください。キーは<a href="' +
    p.getKeyUrl +
    '" target="_blank" rel="noopener">公式ページ</a>で取得できます。<br><button class="btn primary sm" style="margin-top:10px" onclick="openSettings(\'' +
    p.id +
    "')\">設定を開く</button></div>";
  col.appendChild(div);
  scrollBottom(false);
  const s = curSession();
  if (s) {
    const last = s.messages[s.messages.length - 1];
    if (last && last.content === "__NOKEY__") {
      last.content = `（${p.name}のキーが未設定のため送信できませんでした。設定からキーを追加してください）`;
    }
  }
}

function showErrorBanner(msg: string, p: Provider): void {
  const col = $("#chatCol");
  const div = document.createElement("div");
  div.className = "banner";
  div.innerHTML =
    '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5m0 3h.01"/></svg><div><b>エラー</b><br>' +
    esc(msg) +
    '<br><button class="btn secondary sm" style="margin-top:10px" onclick="openSettings(\'' +
    p.id +
    "')\">設定でキーを確認</button></div>";
  col.appendChild(div);
  scrollBottom(false);
}

/** 設定欄の入力を読む（CloudflareはAccount IDとトークンを結合） */
function readKeyInput(pid: string): string {
  const keyInp = document.querySelector<HTMLInputElement>(`#key-${pid}`);
  const token = (keyInp?.value || "").trim();
  if (!findProvider(pid).dualKey) return token;
  const acctInp = document.querySelector<HTMLInputElement>(`#acct-${pid}`);
  return joinSavedKey(pid, (acctInp?.value || "").trim(), token);
}

async function sendMessage(): Promise<void> {
  const ta = $("#input") as HTMLTextAreaElement;
  const text = ta.value.trim();
  if (!text || runtime.generating) return;
  ensureSession();
  const s = curSession();
  if (!s) return;
  const p = curProv();
  const model = curModel();
  s.provider = state.conf.provider;
  s.model = model;
  s.messages.push({ role: "user", content: text });
  if (s.messages.length === 1) s.title = text.slice(0, 28);
  ta.value = "";
  autoGrow(ta);
  const aiMsg: Message = { role: "assistant", content: "", model, pending: true };
  s.messages.push(aiMsg);
  s.providerAtSend = p.id;
  persistSessions();
  renderAll();

  const key = (state.keys[p.id] || "").trim();
  if (!key) {
    aiMsg.pending = false;
    aiMsg.content = "__NOKEY__";
    renderChatWithNoKey(p);
    persistSessions();
    return;
  }

  runtime.generating = true;
  runtime.abortCtl = new AbortController();
  setSendBtn(true);
  const histForCall = s.messages
    .slice(0, -1)
    .filter((m) => m.content && m.content !== "__NOKEY__");
  const effortNote =
    state.conf.effort === "low"
      ? "最小限のコードで、簡潔に返してください。"
      : state.conf.effort === "high"
        ? "丁寧に、動作を検証した完成度の高いコードにしてください。"
        : state.conf.effort === "super"
          ? "段階的に考え、ツールも活用して、検証済みの完成コードにしてください。"
          : "";
  if (state.conf.mode === "code") {
    const lastUser = [...histForCall].reverse().find((m) => m.role === "user");
    if (lastUser) {
      const idx = histForCall.indexOf(lastUser);
      histForCall[idx] = {
        ...lastUser,
        content:
          "【コード作成の指示】あなたはコード作成に特化したAIです。依頼に対して、動作する完成コードを ```言語名 のコードブロックで返してください。" +
          "Webページやアプリは単一HTMLファイル（CSSとJavaScriptを内蔵）で完結させてください。説明は最小限にし、コードを主役にしてください。" +
          "修正の依頼では、変更後のコード全体を返してください。" +
          effortNote +
          "\n\n【依頼】\n" + lastUser.content,
      };
    }
  } else if (state.conf.effort !== "medium") {
    const lastUser = [...histForCall].reverse().find((m) => m.role === "user");
    if (lastUser) {
      const idx = histForCall.indexOf(lastUser);
      const note =
        state.conf.effort === "low"
          ? "（簡潔に短く答えてください）"
          : state.conf.effort === "high"
            ? "（詳しく丁寧に答えてください）"
            : "（段階的に深く考えてから、詳しく答えてください）";
      histForCall[idx] = { ...lastUser, content: lastUser.content + "\n" + note };
    }
  }
  const onDelta = (full: string): void => {
    aiMsg.content = full;
    aiMsg.pending = false;
    updateStreamingMsg(s, aiMsg);
  };
  try {
    if (state.conf.agent || (state.conf.mode === "code" && state.conf.effort === "super")) {
      const r = await runAgent(p, key, model, histForCall, (steps) => {
        aiMsg.steps = steps;
        aiMsg.pending = false;
        aiMsg.content = aiMsg.content || "エージェントが作業中です…";
        updateStreamingMsg(s, aiMsg);
      });
      aiMsg.steps = r.steps;
      aiMsg.content = r.text;
      aiMsg.pending = false;
      runtime.generating = false;
      runtime.abortCtl = null;
      setSendBtn(false);
      persistSessions();
      renderAll();
      await maybeVerify(s, aiMsg);
      if (isLoggedIn()) void pushSync();
      return;
    }
    const full = await callChat(p, key, model, histForCall, onDelta);
    aiMsg.content = full;
    aiMsg.pending = false;
  } catch (e) {
    aiMsg.pending = false;
    if (e instanceof DOMException && e.name === "AbortError") {
      aiMsg.content = aiMsg.content || "（生成を止めました）";
    } else {
      aiMsg.content = "";
      aiMsg.error = e instanceof Error ? e.message : String(e);
    }
  }
  if (!aiMsg.error) await maybeVerify(s, aiMsg);
  runtime.generating = false;
  runtime.abortCtl = null;
  setSendBtn(false);
  persistSessions();
  renderAll();
  if (!aiMsg.error && isLoggedIn()) void pushSync();
  if (aiMsg.error) showErrorBanner(aiMsg.error, p);
}

/** コードモードのHigh／Super high：生成コードを裏で検証し、エラー時はAI修復する */
async function maybeVerify(s: Session, aiMsg: Message): Promise<void> {
  if (state.conf.mode !== "code") return;
  const ef = state.conf.effort;
  if (ef !== "high" && ef !== "super") return;
  const idx = s.messages.indexOf(aiMsg);
  if (idx < 0) return;
  await verifyAndRepair(s.id, idx, ef === "super" ? 2 : 1);
}

/* ---------- モード切替（左上ロゴ） ---------- */

export function applyMode(): void {
  const isCode = state.conf.mode === "code";
  document.body.classList.toggle("mode-code", isCode);
  $("#btnModeLogo").classList.toggle("on", isCode);
  ($("#input") as HTMLTextAreaElement).placeholder = isCode
    ? "作りたいものを説明してください"
    : "AIに質問してみよう";
  $("#btnPlusMode").textContent = isCode ? "チャットモードに切り替え" : "コードモードに切り替え";
}

function toggleMode(): void {
  state.conf.mode = state.conf.mode === "code" ? "chat" : "code";
  persistConf();
  state.currentId = null;
  ensureSession();
  applyMode();
  renderAll();
  toast(state.conf.mode === "code" ? "コードモードに切り替えました（コード出力に特化したチャットです）" : "チャットモードに切り替えました");
  if (isLoggedIn()) void pushSync();
}

/* ---------- 入力欄 ---------- */

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 150) + "px";
}

function toggleTheme(): void {
  const next = currentTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  toast(next === "dark" ? "ダークモードにしました" : "ライトモードにしました");
}

/* ---------- イベント配線 ---------- */

document.addEventListener("click", (e: Event) => {
  const target = e.target as HTMLElement;

  const close = target.closest<HTMLElement>("[data-close]");
  if (close) {
    closeSheet(close.getAttribute("data-close") as string);
    return;
  }
  const os = target.closest<HTMLElement>("[data-open-settings]");
  if (os) {
    openSettings(os.getAttribute("data-open-settings") as string);
    return;
  }
  const dn = target.closest<HTMLElement>("[data-del-note]");
  if (dn) {
    const nid = dn.getAttribute("data-del-note") as string;
    state.notes = state.notes.filter((n) => n.id !== nid);
    persistNotes();
    if (isLoggedIn()) void pushSync();
    renderNotes();
    toast("メモを削除しました");
    return;
  }
  const del = target.closest<HTMLElement>("[data-del]");
  if (del) {
    e.stopPropagation();
    if (window.confirm("この会話を削除しますか？")) {
      deleteSession(del.getAttribute("data-del") as string);
      renderAll();
    }
    return;
  }
  const sess = target.closest<HTMLElement>("[data-sess]");
  if (sess) {
    state.currentId = sess.getAttribute("data-sess");
    renderAll();
    closeSidebar();
    return;
  }
  const mprov = target.closest<HTMLElement>("[data-mprov]");
  if (mprov) {
    const id = mprov.getAttribute("data-mprov") as string;
    state.conf.provider = id;
    persistConf();
    renderAll();
    renderModelSheet(($("#modelSearch") as HTMLInputElement).value || "");
    if (id === "auto") {
      toast("Eluntra Auto：接続済みの中から最適なものを自動で選びます");
      void autoFetchModels(curProv().id);
    } else {
      toast(`${findProvider(id).name}に切り替えました`);
      void autoFetchModels(id);
    }
    if (isLoggedIn()) void pushSync();
    return;
  }
  const pick = target.closest<HTMLElement>("[data-pick-prov]");
  if (pick) {
    const id = pick.getAttribute("data-pick-prov") as string;
    state.conf.provider = id;
    persistConf();
    renderAll();
    if (id === "auto") {
      toast("Eluntra Auto：接続済みの中から最適なものを自動で選びます");
      void autoFetchModels(curProv().id);
    } else {
      toast(`${findProvider(id).name}に切り替えました`);
      void autoFetchModels(id);
    }
    if (isLoggedIn()) void pushSync();
    return;
  }
  const sugg = target.closest<HTMLElement>("[data-sugg]");
  if (sugg) {
    const ta = $("#input") as HTMLTextAreaElement;
    ta.value = SUGGESTIONS[Number(sugg.getAttribute("data-sugg"))];
    autoGrow(ta);
    ta.focus();
    return;
  }
  const cp = target.closest<HTMLElement>("[data-copy]");
  if (cp) {
    const s = curSession();
    const m = s?.messages[Number(cp.getAttribute("data-copy"))];
    if (m) {
      void navigator.clipboard.writeText(m.content).then(() => toast("コピーしました"));
    }
    return;
  }
  const tk = target.closest<HTMLElement>("[data-toggle-key]");
  if (tk) {
    document
      .querySelector(`#keybox-${tk.getAttribute("data-toggle-key")}`)
      ?.classList.toggle("on");
    return;
  }
  const sk = target.closest<HTMLElement>("[data-show-key]");
  if (sk) {
    const pid = sk.getAttribute("data-show-key") as string;
    const inp = document.querySelector<HTMLInputElement>(`#key-${pid}`);
    if (inp) {
      inp.type = inp.type === "password" ? "text" : "password";
      sk.textContent = inp.type === "password" ? "表示" : "隠す";
    }
    return;
  }
  const sv = target.closest<HTMLElement>("[data-save-key]");
  if (sv) {
    const pid = sv.getAttribute("data-save-key") as string;
    const v = readKeyInput(pid);
    if (v) state.keys[pid] = v;
    else delete state.keys[pid];
    delete state.tested[pid];
    persistKeys();
    persistTested();
    renderSettings();
    renderAll();
    toast(v ? `${findProvider(pid).name}のキーを保存しました` : "キーを削除しました");
    if (v) void autoFetchModels(pid, true);
    return;
  }
  const ts = target.closest<HTMLElement>("[data-test-key]");
  if (ts) {
    void (async () => {
      const pid = ts.getAttribute("data-test-key") as string;
      const v = readKeyInput(pid);
      if (v) {
        state.keys[pid] = v;
        persistKeys();
      }
      const box = document.querySelector<HTMLElement>(`#test-${pid}`);
      if (box) {
        box.className = "test-result on";
        box.style.color = "var(--text-2)";
        box.textContent = "接続テスト中…";
      }
      const r = await testConnection(pid);
      if (box) {
        box.className = "test-result on " + (r.ok ? "ok" : "ng");
        box.textContent = (r.ok ? "成功：" : "失敗：") + r.msg;
      }
      renderAll();
    })();
    return;
  }
  const up = target.closest<HTMLElement>("[data-use-prov]");
  if (up) {
    state.conf.provider = up.getAttribute("data-use-prov") as string;
    persistConf();
    renderSettings();
    renderAll();
    void autoFetchModels(state.conf.provider);
    toast(`${findProvider(state.conf.provider).name}を使う設定にしました`);
    return;
  }
  const lg = target.closest<HTMLElement>("[data-login]");
  if (lg) {
    loginWith(lg.getAttribute("data-login") as OAuthProvider);
    return;
  }
  const ol = target.closest<HTMLElement>("[data-open-login]");
  if (ol) {
    renderAccount();
    openSheet("loginSheet");
    closeSidebar();
    return;
  }
  if (target.closest("#btnSyncNow")) {
    void (async () => {
      const pulled = await pullSync();
      if (pulled === "applied") {
        renderAll();
        toast("クラウドのデータを取り込みました");
      }
      const ok = await pushSync();
      renderAccount();
      toast(ok ? "同期しました" : "同期に失敗しました。通信状態を確認してください");
    })();
    return;
  }
  if (target.closest("#btnLogout") || target.closest("#btnLogoutSide")) {
    void (async () => {
      await logout();
      closeSheet("loginSheet");
      renderAccount();
      localStorage.removeItem("eluntra_guest");
      document.body.classList.add("show-welcome");
      toast("ログアウトしました");
    })();
    return;
  }
  const mi = target.closest<HTMLElement>("[data-model]");
  if (mi) {
    state.conf.models[curProv().id] = mi.getAttribute("data-model") as string;
    persistConf();
    renderAll();
    closeSheet("modelSheet");
    toast(`モデルを ${state.conf.models[curProv().id]} にしました`);
    return;
  }
});

$("#btnNewChat").addEventListener("click", () => {
  createSession();
  renderAll();
  closeSidebar();
  ($("#input") as HTMLTextAreaElement).focus();
});
$("#btnNewTop").addEventListener("click", () => {
  createSession();
  renderAll();
  ($("#input") as HTMLTextAreaElement).focus();
});
$("#btnMenu").addEventListener("click", openSidebar);
$("#scrim").addEventListener("click", closeSidebar);
$("#btnAccountTop").addEventListener("click", () => {
  renderAccount();
  openSheet("loginSheet");
});
$("#btnSettingsSide").addEventListener("click", () => openSettings());
 $("#btnSettingsTop").addEventListener("click", () => openSettings());
$("#btnTheme").addEventListener("click", toggleTheme);
$("#btnTheme2").addEventListener("click", toggleTheme);
 $("#modelPillTop").addEventListener("click", () => {
  openModelSheet();
  void autoFetchModels(state.conf.provider);
});
$("#modelSearch").addEventListener("input", (e: Event) => {
  renderModelSheet((e.target as HTMLInputElement).value);
});
$("#btnFetchModels").addEventListener("click", () => {
  void (async () => {
    const btn = $("#btnFetchModels") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "取得中…";
    try {
      const ids = await fetchModels(state.conf.provider);
      renderModelSheet(($("#modelSearch") as HTMLInputElement).value);
      renderAll();
      toast(`${ids.length}件のモデルを取得しました`);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      btn.disabled = false;
      btn.textContent = "一覧を取得";
    }
  })();
});
$("#btnCustomModel").addEventListener("click", () => {
  const v = ($("#customModel") as HTMLInputElement).value.trim();
  if (!v) return;
  state.conf.models[curProv().id] = v;
  persistConf();
  renderAll();
  closeSheet("modelSheet");
  toast(`モデルを ${v} にしました`);
});
$("#keyStateLabel").addEventListener("click", () => {
  openSettings(state.conf.provider);
});
initCodeUI();
$("#btnModeLogo").addEventListener("click", () => {
  toggleMode();
});
$("#btnPlus").addEventListener("click", () => {
  openSheet("plusSheet");
});
$("#btnPlusSettings").addEventListener("click", () => {
  openSettings(state.conf.provider);
});
$("#btnThemePlus").addEventListener("click", toggleTheme);
$("#btnPlusMode").addEventListener("click", () => {
  toggleMode();
});
$("#btnEffort").addEventListener("click", () => openSheet("effortSheet"));
document.querySelectorAll(".effort-row").forEach((r) => {
  r.addEventListener("click", () => {
    const v = r.getAttribute("data-effort");
    if (v === "low" || v === "medium" || v === "high" || v === "super") {
      state.conf.effort = v;
      persistConf();
      renderAll();
      closeSheet("effortSheet");
      toast(`強さを ${v === "low" ? "Low" : v === "medium" ? "Medium" : v === "high" ? "High" : "Super high"} にしました`);
      if (isLoggedIn()) void pushSync();
    }
  });
});
$("#btnAgent").addEventListener("click", () => {
  state.conf.agent = !state.conf.agent;
  persistConf();
  renderAll();
  toast(state.conf.agent ? "エージェントモードをオンにしました（ツールを使いながら回答します）" : "エージェントモードをオフにしました");
});
$("#btnSys").addEventListener("click", () => {
  $("#sysbar").classList.toggle("on");
});
$("#sysPrompt").addEventListener("input", (e: Event) => {
  state.conf.system = (e.target as HTMLTextAreaElement).value;
  persistConf();
});
$("#tempRange").addEventListener("input", (e: Event) => {
  const v = Number((e.target as HTMLInputElement).value);
  state.conf.temp = v;
  $("#tempVal").textContent = v.toFixed(1);
  persistConf();
});
$("#btnSend").addEventListener("click", () => {
  if (runtime.generating) {
    runtime.abortCtl?.abort();
  } else {
    void sendMessage();
  }
});
$("#input").addEventListener("input", (e: Event) => {
  autoGrow(e.target as HTMLTextAreaElement);
});
$("#input").addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendMessage();
  }
});

function download(name: string, content: string, type: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("#btnExport").addEventListener("click", () => {
  const s = curSession();
  if (!s || !s.messages.length) {
    toast("書き出す会話がありません");
    return;
  }
  const txt =
    `# ${s.title}\n\n` +
    s.messages
      .map(
        (m) =>
          (m.role === "user"
            ? "## あなた"
            : `## ${findProvider(s.provider).name}（${m.model || ""}）`) +
          `\n\n${m.content}`,
      )
      .join("\n\n");
  download("eluntra-chat.md", txt, "text/markdown");
});
$("#btnExportAll").addEventListener("click", () => {
  const data = {
    exportedAt: new Date().toISOString(),
    conf: state.conf,
    sessions: state.sessions,
    providers: Object.keys(state.keys),
  };
  download("eluntra-data.json", JSON.stringify(data, null, 2), "application/json");
  toast("書き出しました（キー本体は含みません）");
});
$("#btnWipe").addEventListener("click", () => {
  if (!window.confirm("キー・会話・設定をすべて削除しますか？この操作は戻せません。")) return;
  resetAllData();
  renderSettings();
  renderAll();
  toast("すべて削除しました");
});
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape") {
    closeSheet("modelSheet");
    closeSheet("settingsSheet");
    closeSheet("loginSheet");
    closeSidebar();
  }
});

/* ---------- 最初のページ（ウェルカム） ---------- */

function enterApp(): void {
  document.body.classList.remove("show-welcome");
}

function openLoginFromWelcome(): void {
  renderAccount();
  openSheet("loginSheet");
}

function enterAsGuest(): void {
  try {
    localStorage.setItem("eluntra_guest", "1");
  } catch {
    /* ignore */
  }
  enterApp();
  ($("#input") as HTMLTextAreaElement).focus();
}

document
  .querySelectorAll(".w-login-btn")
  .forEach((b) => b.addEventListener("click", openLoginFromWelcome));
document
  .querySelectorAll(".w-guest-btn")
  .forEach((b) => b.addEventListener("click", enterAsGuest));

/* ---------- 初期化 ---------- */

(function init(): void {
  installWatchdog();
  $("#btnSelfRepair").addEventListener("click", () => void runSelfRepair(false));
  $("#btnRepairLog").addEventListener("click", () => copyRepairLog());
  $("#chkAutoRepair").addEventListener("change", (e: Event) => {
    setAutoRepair((e.target as HTMLInputElement).checked);
    toast((e.target as HTMLInputElement).checked ? "自動修復をオンにしました" : "自動修復をオフにしました");
  });
  renderRepairPanel();
  const savedTheme = load<string | null>("eluntra_theme", null);
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme || (prefersDark ? "dark" : "light"));
  state.currentId = null;
  ensureSession();
  applyMode();
  ($("#sysPrompt") as HTMLTextAreaElement).value = state.conf.system || "";
  ($("#tempRange") as HTMLInputElement).value = String(state.conf.temp);
  $("#tempVal").textContent = Number(state.conf.temp).toFixed(1);
  renderAll();
  renderAccount();
  void autoFetchModels(state.conf.provider);
  $("#welcomeKeyLinks").innerHTML = PROVIDERS.map(
    (p) =>
      `<a class="w-keylink" href="${p.getKeyUrl}" target="_blank" rel="noopener">${logoTile(p.id, true)}${esc(p.name)}のキー取得</a>`,
  ).join("");
  $("#welcomeProvs").innerHTML = PROVIDERS.map(
    (p) =>
      `<span class="w-prov">${logoTile(p.id, true)}${esc(p.name)}</span>`,
  ).join("");
  let guest = false;
  try {
    guest = localStorage.getItem("eluntra_guest") === "1";
  } catch {
    guest = false;
  }
  if (!isLoggedIn() && !guest) document.body.classList.add("show-welcome");
  onAuthChange(renderAccount);
  void (async () => {
    const cb = await handleAuthCallback();
    if (cb.error) {
      toast("ログインできませんでした：" + cb.error + "（Appleは提供側の設定が完了するまで使えません）");
    }
    if (cb.handled && !cb.error) {
      toast("ログインしました");
      enterApp();
    }
    if (isLoggedIn()) {
      const pulled = await pullSync();
      if (pulled === "applied") {
        renderAll();
        toast("クラウドのデータを取り込みました");
      } else if (pulled === "none") {
        await pushSync();
      }
      renderAccount();
    }
  })();
})();
