import "./styles.css";
import { callChat, fetchModels, testConnection } from "./api";
import { findProvider } from "./providers";
import {
  SUGGESTIONS,
  applyTheme,
  closeSheet,
  closeSidebar,
  currentTheme,
  openModelSheet,
  openSettings,
  openSidebar,
  renderAll,
  renderModelSheet,
  renderSettings,
  scrollBottom,
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
  persistKeys,
  persistSessions,
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
  const onDelta = (full: string): void => {
    aiMsg.content = full;
    aiMsg.pending = false;
    updateStreamingMsg(s, aiMsg);
  };
  try {
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
  runtime.generating = false;
  runtime.abortCtl = null;
  setSendBtn(false);
  persistSessions();
  renderAll();
  if (aiMsg.error) showErrorBanner(aiMsg.error, p);
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
  const pick = target.closest<HTMLElement>("[data-pick-prov]");
  if (pick) {
    state.conf.provider = pick.getAttribute("data-pick-prov") as string;
    persistConf();
    renderAll();
    toast(`${findProvider(state.conf.provider).name}に切り替えました`);
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
    const inp = document.querySelector<HTMLInputElement>(`#key-${pid}`);
    const v = (inp?.value || "").trim();
    if (v) state.keys[pid] = v;
    else delete state.keys[pid];
    delete state.tested[pid];
    persistKeys();
    persistTested();
    renderSettings();
    renderAll();
    toast(v ? `${findProvider(pid).name}のキーを保存しました` : "キーを削除しました");
    return;
  }
  const ts = target.closest<HTMLElement>("[data-test-key]");
  if (ts) {
    void (async () => {
      const pid = ts.getAttribute("data-test-key") as string;
      const inp = document.querySelector<HTMLInputElement>(`#key-${pid}`);
      const v = (inp?.value || "").trim();
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
    toast(`${findProvider(state.conf.provider).name}を使う設定にしました`);
    return;
  }
  const mi = target.closest<HTMLElement>("[data-model]");
  if (mi) {
    state.conf.models[state.conf.provider] = mi.getAttribute("data-model") as string;
    persistConf();
    renderAll();
    closeSheet("modelSheet");
    toast(`モデルを ${state.conf.models[state.conf.provider]} にしました`);
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
$("#btnSettingsSide").addEventListener("click", () => openSettings());
$("#btnSettingsTop").addEventListener("click", () => openSettings());
$("#btnTheme").addEventListener("click", toggleTheme);
$("#btnTheme2").addEventListener("click", toggleTheme);
$("#modelPillTop").addEventListener("click", openModelSheet);
$("#modelPillBottom").addEventListener("click", openModelSheet);
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
  state.conf.models[state.conf.provider] = v;
  persistConf();
  renderAll();
  closeSheet("modelSheet");
  toast(`モデルを ${v} にしました`);
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
    closeSidebar();
  }
});

/* ---------- 初期化 ---------- */

(function init(): void {
  const savedTheme = load<string | null>("eluntra_theme", null);
  const prefersDark =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(savedTheme || (prefersDark ? "dark" : "light"));
  ($("#sysPrompt") as HTMLTextAreaElement).value = state.conf.system || "";
  ($("#tempRange") as HTMLInputElement).value = String(state.conf.temp);
  $("#tempVal").textContent = Number(state.conf.temp).toFixed(1);
  renderAll();
})();
