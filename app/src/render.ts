import { BRAND_ICONS, currentUser, lastSyncAt } from "./auth";
import { LOGOS, logoTile } from "./logos";
import { md } from "./markdown";
import { PROVIDERS, findProvider } from "./providers";
import {
  curModel,
  curProv,
  curSession,
  ensureSession,
  keyState,
  modelList,
  persistConf,
  sessionKind,
  splitSavedKey,
  state,
  stateLabel,
} from "./state";
import type { Message, Session } from "./types";
import { $, esc } from "./util";

export const SUGGESTIONS: string[] = [
  "今日の献立を、冷蔵庫の残り物で考えて",
  "この英文を自然な日本語にして： The early bird catches the worm.",
  "PythonでCSVを読み込むコードを書いて",
  "小学生にも分かるように、相対性理論を説明して",
];

export const CODE_SUGGESTIONS: string[] = [
  "ストップウォッチのWebページを作って",
  "ToDoリストのアプリをHTMLで作って",
  "Pythonでフィボナッチ数を計算するコードを書いて",
  "おしゃれな名刺カードのHTMLを作って",
];

/* ---------- 描画 ---------- */

export function renderPills(): void {
  const p = curProv();
  const m = curModel();
  const mono = $("#pillMono");
  mono.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${LOGOS[p.id] || ""}</svg>`;
  const auto = state.conf.provider === "auto";
  $("#pillName").textContent = auto ? "Eluntra Auto" : p.name;
  $("#pillModel").textContent = auto ? `${p.name} ・ ${m}` : m;
  const ks = keyState(p.id);
  const pill = $("#keyStateLabel");
  pill.textContent =
    ks === "ok" ? "キー接続OK" : ks === "set" ? "キー設定済み（未テスト）" : "キーを設定すると使えます";
  pill.className = "key-pill" + (ks === "ok" ? " ok" : "");
}

export function renderProvStatus(): void {
  $("#provStatus").innerHTML = PROVIDERS.map((p) => {
    const st = keyState(p.id);
    return `<button class="pstat" data-open-settings="${p.id}">${logoTile(p.id, true)}<span>${esc(p.name)}</span><span class="dot ${st === "ok" ? "ok" : st === "set" ? "set" : ""}"></span></button>`;
  }).join("");
}

export function renderSessions(): void {
  const el = $("#sessionList");
  const list = state.sessions.filter((x) => sessionKind(x) === state.conf.mode);
  if (!list.length) {
    el.innerHTML = '<p style="padding:8px 12px;font-size:13px;color:var(--text-3)">まだ会話がありません</p>';
    return;
  }
  el.innerHTML = list
    .map(
      (s) =>
        `<button class="sess ${s.id === state.currentId ? "on" : ""}" data-sess="${s.id}"><span class="t">${esc(s.title)}</span><span class="del" data-del="${s.id}" role="button" aria-label="削除"><svg class="ic sm" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13h10l1-13"/></svg></span></button>`,
    )
    .join("");
}

export function renderChat(): void {
  const col = $("#chatCol");
  const s = curSession();
  if (!s || !s.messages.length) {
    const provCells = PROVIDERS.map((p) => {
      const st = keyState(p.id);
      return `<button class="prov-chip ${p.id === state.conf.provider ? "on" : ""}" data-pick-prov="${p.id}">${logoTile(p.id, true)}<span>${esc(p.name)}</span><span class="dot ${st === "ok" ? "ok" : st === "set" ? "set" : ""}"></span></button>`;
    }).join("");
    const isCode = state.conf.mode === "code";
    const sugg = isCode ? CODE_SUGGESTIONS : SUGGESTIONS;
    col.innerHTML =
      (isCode
        ? '<div class="empty"><h1>何を作りますか。</h1>'
        : '<div class="empty"><h1>何を聞きますか。</h1>') +
      '<div class="prov-row">' +
      `<button class="prov-chip ${state.conf.provider === "auto" ? "on" : ""}" data-pick-prov="auto"><span class="logo-tile sm">${AUTO_SVG}</span><span>Eluntra Auto</span></button>` +
      provCells +
      '</div>' +
      '<div class="sugg">' +
      sugg.map(
        (t, i) => `<button data-sugg="${i}"><span>${esc(t)}</span></button>`,
      ).join("") +
      "</div></div>";
    return;
  }
  col.innerHTML = s.messages
    .map((m, i) => {
      try {
        return renderMsg(m, i, s);
      } catch {
        return '<div class="msg"><div class="msg-body"><p>このメッセージを表示できませんでした（データが壊れている可能性があります）。設定の「自己修復」で直せます。</p></div></div>';
      }
    })
    .join("");
  scrollBottom(false);
}

function renderMsg(m: Message, i: number, s: Session): string {
  const isUser = m.role === "user";
  const provId = s.providerAtSend || s.provider;
  const prov = PROVIDERS.find((x) => x.id === provId);
  const foot = isUser
    ? ""
    : `<div class="msg-foot"><button class="foot-btn" data-copy="${i}" aria-label="コピー"><svg class="ic sm" viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button></div>`;
  const stepsHtml = m.steps && m.steps.length
    ? `<div class="msg-steps">${m.steps.map((st) => `<div class="step"><svg class="ic sm" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg><span>${esc(st)}</span></div>`).join("")}</div>`
    : "";
  const bodyHtml = m.pending ? '<span class="typing"><i></i><i></i><i></i></span>' : isUser ? md(m.content) : addCodeActions(md(m.content));
  return `<div class="msg${isUser ? " user" : ""}">${stepsHtml}<div class="msg-body">${bodyHtml}</div>${foot}</div>`;
}

/** 言語名の正規化（フェンス表記ゆれ吸収） */
export function normLang(raw: string, code: string): string {
  const l = (raw || "").toLowerCase();
  if (l === "js" || l === "javascript" || l === "node") return "javascript";
  if (l === "ts" || l === "typescript") return "typescript";
  if (l === "py" || l === "python") return "python";
  if (l === "html" || l === "xml") return "html";
  if (l === "css") return "css";
  if (l === "json") return "json";
  if (l === "md" || l === "markdown") return "markdown";
  if (l) return l;
  const head = code.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith("<!doctype") || head.startsWith("<html") || head.includes("<body")) return "html";
  return "";
}

/** AI回答のコードブロック直下に、プレビュー／コード／Zipなどの操作バーを付ける */
export function addCodeActions(html: string): string {
  return html.replace(/<pre><code data-lang="(\w*)">([\s\S]*?)<\/code><\/pre>/g, (whole, rawLang: string, escCode: string) => {
    const codeText = escCode.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const lang = normLang(rawLang, codeText);
    const btn = (act: string, label: string) => `<button class="cact" data-cact="${act}">${label}</button>`;
    let bar = '<div class="code-actions">';
    if (lang === "html") bar += btn("preview", "プレビュー");
    if (lang === "javascript") bar += btn("run", "実行する");
    bar += btn("code", "コード") + btn("zip", "Zipで保存") + btn("copy", "コピー");
    if (lang === "html") bar += btn("publish", "公開する");
    bar += "</div>";
    return whole + bar;
  });
}

export function scrollBottom(smooth = true): void {
  const sc = $("#chatScroll");
  requestAnimationFrame(() => {
    sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  });
}

const LOGOUT_SVG = '<svg class="ic" viewBox="0 0 24 24"><path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';
const CLOUD_SVG = '<svg class="ic" viewBox="0 0 24 24"><path d="M17.5 19a4.5 4.5 0 0 0 .9-8.9 6 6 0 0 0-11.7 1.2A4 4 0 0 0 7 19h10.5z"/><path d="M12 19v-6"/><path d="M9.5 15.5 12 13l2.5 2.5"/></svg>';

/** サイドバーのアカウント欄と、ログインシートの中身を描く */
export function renderAccount(): void {
  const box = $("#accountBox");
  const body = $("#loginBody");
  if (!box || !body) return;
  const user = currentUser();
  if (!user) {
    box.innerHTML =
      `<button class="btn primary" style="width:100%" data-open-login>ログイン</button>` +
      `<p class="login-note" style="margin-top:8px">ログインすると会話をクラウドに保存できます</p>`;
    body.innerHTML =
      `<p class="set-desc">会話と設定（APIキーを除く）をクラウドに保存して、別の端末でも続きから使えるようになります。APIキーは端末の中にだけ保存され、クラウドには送りません。</p>` +
      `<button class="login-btn github" data-login="github">${BRAND_ICONS.github}<span>GitHubでログイン</span></button>` +
      `<button class="login-btn" data-login="google">${BRAND_ICONS.google}<span>Googleでログイン</span></button>` +
      `<button class="login-btn apple" data-login="apple">${BRAND_ICONS.apple}<span>Appleでログイン</span></button>` +
      `<p class="login-note">ログインはSupabase Authを通して行われます。Appleログインは提供側の設定が完了したあとに使えます（未設定の間はエラーになります）。</p>`;
    return;
  }
  const initial = esc((user.name || user.email || "?").charAt(0).toUpperCase());
  const avatar = user.avatarUrl
    ? `<img class="acct-avatar" src="${esc(user.avatarUrl)}" alt="">`
    : `<span class="acct-initial">${initial}</span>`;
  box.innerHTML =
    `<div class="acct-row">${avatar}<div class="acct-texts">` +
    `<div class="acct-name">${esc(user.name || "ログイン中")}</div>` +
    `<div class="acct-mail">${esc(user.email)}</div></div>` +
    `<button class="icon-btn" id="btnLogoutSide" aria-label="ログアウト" title="ログアウト">${LOGOUT_SVG}</button></div>`;
  const sync = lastSyncAt();
  body.innerHTML =
    `<div class="acct-row">${avatar}<div class="acct-texts">` +
    `<div class="acct-name">${esc(user.name || "ログイン中")}</div>` +
    `<div class="acct-mail">${esc(user.email)}</div></div></div>` +
    `<p class="sync-line">${
      sync ? `最終同期：${new Date(sync).toLocaleString("ja-JP")}` : "まだクラウドに保存していません"
    }</p>` +
    `<button class="btn primary" id="btnSyncNow" style="width:100%;margin-top:12px">${CLOUD_SVG}<span>今すぐ同期する</span></button>` +
    `<button class="btn danger" id="btnLogout" style="width:100%;margin-top:10px">${LOGOUT_SVG}<span>ログアウト</span></button>` +
    `<p class="login-note">同期されるのは会話と設定だけです。APIキーはこの端末の中にだけ残ります。</p>`;
}

export const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  super: "Super high",
};

export function renderAll(): void {
  const ag = document.querySelector<HTMLElement>("#btnAgent");
  if (ag) ag.classList.toggle("on", state.conf.agent);
  const ef = document.querySelector<HTMLElement>("#btnEffort");
  if (ef) ef.textContent = EFFORT_LABELS[state.conf.effort] || "Medium";
  document.querySelectorAll(".effort-row").forEach((r) => {
    r.classList.toggle("on", r.getAttribute("data-effort") === state.conf.effort);
  });
  ensureSession();
  renderPills();
  renderProvStatus();
  renderSessions();
  renderChat();
  persistConf();
}

/* ---------- シート開閉 ---------- */

export function openSheet(id: string): void {
  $(`#${id}`).classList.add("on");
}
export function closeSheet(id: string): void {
  $(`#${id}`).classList.remove("on");
}
export function openSidebar(): void {
  $("#sidebar").classList.add("on");
  $("#scrim").classList.add("on");
}
export function closeSidebar(): void {
  $("#sidebar").classList.remove("on");
  $("#scrim").classList.remove("on");
}

/* ---------- 設定シート ---------- */

export function renderSettings(): void {
  const chkP = document.querySelector<HTMLInputElement>("#chkProxy");
  if (chkP) chkP.checked = state.conf.proxyOn !== false;
  $("#provSettings").innerHTML = PROVIDERS.map((p) => {
    const st = keyState(p.id);
    const stCls = st === "ok" ? "ok" : st === "set" ? "set" : "";
    return (
      `<div class="prov-row" id="prov-${p.id}">` +
      `<div class="prov-row-head">${logoTile(p.id)}` +
      `<span><span class="pr-name">${esc(p.name)}</span><br><span class="pr-model">${esc(state.conf.models[p.id])}</span></span>` +
      `<span class="st ${stCls}">${stateLabel(p.id)}</span>` +
      `<button class="icon-btn" data-toggle-key="${p.id}" aria-label="キー設定を開く"><svg class="ic" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button></div>` +
      `<div class="key-box" id="keybox-${p.id}">` +
      (p.dualKey
        ? `<div class="key-line" style="margin-bottom:8px"><input type="text" id="acct-${p.id}" placeholder="Account ID" value="${esc(splitSavedKey(p.id, state.keys[p.id] || "").acct)}" autocomplete="off" spellcheck="false"></div>`
        : "") +
      `<div class="key-line"><input type="password" id="key-${p.id}" placeholder="${esc(p.keyHint)}" value="${esc(splitSavedKey(p.id, state.keys[p.id] || "").token)}" autocomplete="off" spellcheck="false">` +
      `<button class="btn secondary" data-show-key="${p.id}">表示</button></div>` +
      (p.id === "sambanova"
        ? `<p class="set-desc" style="margin:0 0 8px">注意：SambaNovaはブラウザから直接つなげないため、設定の「接続」で「サーバー経由で接続」がオンのときだけ使えます。</p>`
        : "") +
      `<div class="key-actions"><button class="btn primary sm" data-save-key="${p.id}">保存</button>` +
      `<button class="btn secondary sm" data-test-key="${p.id}">接続テスト</button>` +
      `<button class="btn ghost sm" data-use-prov="${p.id}">この会社を使う</button>` +
      `<a class="get-key" href="${p.getKeyUrl}" target="_blank" rel="noopener">キーを取得する</a></div>` +
      `<div class="test-result" id="test-${p.id}"></div>` +
      `</div></div>`
    );
  }).join("");
  renderNotes();
}

/** メモ一覧（エージェントが保存。ログイン時はSupabaseへ同期） */
export function renderNotes(): void {
  const box = document.querySelector<HTMLElement>("#notesList");
  if (!box) return;
  if (!state.notes.length) {
    box.innerHTML = '<p class="set-desc">まだメモはありません。エージェントに「調べてメモに保存して」と頼むと、ここに残ります。</p>';
    return;
  }
  box.innerHTML = state.notes.map((n) => {
    const d = new Date(n.created);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `<div class="note-row"><div class="note-main"><div class="note-title">${esc(n.title)}</div><div class="note-meta">${when} ・ ${esc(n.content.slice(0, 60))}</div></div><button class="btn ghost sm" data-del-note="${n.id}">削除</button></div>`;
  }).join("");
}

export function openSettings(focusPid?: string): void {
  renderSettings();
  openSheet("settingsSheet");
  closeSidebar();
  if (!focusPid) {
    /* 指定がなければ、いま使っている会社のキー欄を最初から開いておく */
    document
      .querySelector(`#keybox-${state.conf.provider}`)
      ?.classList.add("on");
  }
  if (focusPid) {
    const box = document.querySelector<HTMLElement>(`#keybox-${focusPid}`);
    if (box) {
      box.classList.add("on");
      window.setTimeout(() => {
        box.scrollIntoView({ behavior: "smooth", block: "center" });
        document.querySelector<HTMLInputElement>(`#key-${focusPid}`)?.focus();
      }, 80);
    }
  }
}

/* ---------- モデルシート ---------- */

const AUTO_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/></svg>';

export function renderModelSheet(filter = ""): void {
  const p = curProv();
  const auto = state.conf.provider === "auto";
  $("#modelSheetTitle").textContent = auto ? `Eluntra Auto（現在：${p.name}）` : p.name;
  const row = document.querySelector<HTMLElement>("#modelProvRow");
  if (row) {
    row.innerHTML =
      `<button class="mprov ${auto ? "on" : ""}" data-mprov="auto">${AUTO_SVG}<span>Auto</span></button>` +
      PROVIDERS.map(
        (x) =>
          `<button class="mprov ${!auto && x.id === p.id ? "on" : ""}" data-mprov="${x.id}">${logoTile(x.id, true)}<span>${esc(x.name)}</span></button>`,
      ).join("");
  }
  const list = modelList(p.id).filter(
    (m) => !filter || m.toLowerCase().includes(filter.toLowerCase()),
  );
  $("#modelList").innerHTML = list.length
    ? list
        .map(
          (m) =>
            `<button class="model-item ${m === curModel() ? "on" : ""}" data-model="${esc(m)}"><span class="mi-id">${esc(m)}</span><svg class="ic sm check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></button>`,
        )
        .join("")
    : '<p style="padding:16px 0;color:var(--text-2);font-size:14px">一致するモデルがありません。下のカスタム入力で直接指定できます。</p>';
}

export function openModelSheet(): void {
  renderModelSheet();
  ($(`#modelSearch`) as HTMLInputElement).value = "";
  openSheet("modelSheet");
}

/* ---------- テーマ ---------- */

export function applyTheme(t: string): void {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("eluntra_theme", JSON.stringify(t));
  } catch {
    /* ignore */
  }
}

export function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export { findProvider };
