/* Eluntra Developer: 描画層（ShellMain と各パネル）
   状態の正は DeveloperApp.tsx が持ち、ここは props 経由で描画と操作を行う。 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveAuto } from "../lib/auto";
import { allProviders, getState, hasCredentials, modelListOf, providerDefOf, selectedModel, update } from "../lib/store";
import type { AppConfig, ChatMessage, Effort } from "../lib/types";
import { Logo } from "../components/Logo";
import { Icon } from "../components/icons";
import {
  DEV_MODES, READONLY_MODES, runDevAgent, type AgentEvent, type ChangeRecord, type DevMode,
} from "./agent";
import {
  chatMessageCount, getProjectChat, interleaveChat, nextChatSeq, splitChatItems, trimChat,
  type DevChatEvent, type DevChatItem, type DevChats, type ProjectChat,
} from "./chatstore";
import type { BottomTab, DevView, MobileTab } from "./DeveloperApp";
import { Editor, type EditorApi, type MarkerInfo } from "./Editor";
import {
  TEMPLATES, buildStaticPreview, createProject, deletePath, diffLines, diffStat, foldersOf, listPaths,
  normalizePath, renamePath, revertChange, searchFiles, type DevProject,
} from "./fs";
import {
  ghChangedFiles, ghCreateBranch, ghCreatePR, ghCreateRepo, ghHeadSha, ghListBranches, ghListBranchesDetailed, ghListRepos, ghOpenRepo, ghPush,
  ghViewer, githubConnected, type GhBranch, type GhRepo,
} from "./github";
import { wcService } from "./webcontainer";
import { applyPyChanges, parsePythonCommand, pyService, type ParsedTermCommand, type PyChange } from "./python";
import { dbService, formatOutcomeForAgent, formatSchemaForAgent, type DbMeta } from "./db";
import { termBus } from "./term";
import { DbPane } from "./dbpanel";

/* ---------- アイコン（線描き） ---------- */

const DEV_PATHS: Record<string, React.ReactNode> = {
  folder: <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></>,
  file: <><path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7Z" /><path d="M14 3v4h4" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3m5 0h5" /></>,
  play: <><path d="M7 4.5v15l13-7.5Z" /></>,
  branch: <><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7m12-5c0 4-5 4-8.5 5.5" /></>,
  db: <><ellipse cx="12" cy="5.5" rx="8" ry="3" /><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  back: <><path d="M15 5l-7 7 7 7" /></>,
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M9 20h6m-3-4v4" /></>,
  expand: <><path d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5" /></>,
  shrink: <><path d="M4 9h5V4m6 5h5V4M4 15h5v5m6-5h5v5" /></>,
  phone: <><rect x="7" y="2.5" width="10" height="19" rx="2" /><path d="M11 18.5h2" /></>,
  tablet: <><rect x="5" y="2.5" width="14" height="19" rx="2" /><path d="M11 18.5h2" /></>,
};

export function DIcon({ name, className = "dev-ic" }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {DEV_PATHS[name]}
    </svg>
  );
}

export function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** ダッシュボード用: 更新日時の相対表記（古いものは日付） */
export function fmtRelative(at: number): string {
  const diff = Date.now() - at;
  if (diff < 60_000) return "たった今";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}時間前`;
  if (diff < 86_400_000 * 30) return `${Math.floor(diff / 86_400_000)}日前`;
  return new Date(at).toLocaleDateString("ja-JP");
}

/* ---------- 共有型 ---------- */

export interface ShellProps {
  theme: "light" | "dark";
  conf: AppConfig;
  projects: DevProject[];
  project: DevProject | null;
  activeId: string;
  setActiveId: (id: string) => void;
  /* ダッシュボード／ワークスペース */
  view: DevView;
  setView: (v: DevView) => void;
  enterProject: (id: string) => void;
  goDashboard: () => void;
  lastActiveId: string;
  /* AI実行中フラグ（実行中は切替・削除・ダッシュボード復帰を無効化） */
  agentRunning: boolean;
  setAgentRunning: (b: boolean) => void;
  /* プロジェクト別チャット */
  chats: DevChats;
  chatData: ProjectChat;
  onChatChange: (projectId: string, chat: ProjectChat) => void;
  deleteProject: (id: string) => void;
  commitProjects: (next: DevProject[]) => void;
  updateProject: (id: string, fn: (p: DevProject) => DevProject) => void;
  applyFileChange: (
    files: Record<string, string>,
    log?: { path: string; kind: "create" | "edit" | "delete" | "rename"; source: "user" | "ai" | "github"; detail?: string },
  ) => void;
  openTabs: string[];
  activePath: string | null;
  /* AIチャットの拡大表示（v7.2.7） */
  chatWide: boolean;
  setChatWide: (b: boolean) => void;
  openFile: (path: string) => void;
  closeTab: (path: string) => void;
  setActivePath: (p: string | null) => void;
  activeContent: string;
  onEditorChange: (v: string) => void;
  flushEdit: () => void;
  doUndo: () => void;
  doRedo: () => void;
  bottomTab: BottomTab | null;
  setBottomTab: (t: BottomTab | null) => void;
  mobileTab: MobileTab;
  setMobileTab: (t: MobileTab) => void;
  showDiff: boolean;
  setShowDiff: (b: boolean) => void;
  diffPair: { title: string; before: string; after: string } | null;
  setDiffPair: (d: { title: string; before: string; after: string } | null) => void;
  markers: MarkerInfo[];
  setMarkers: (m: MarkerInfo[]) => void;
  editorApiRef: React.MutableRefObject<EditorApi | null>;
  baselineRef: React.MutableRefObject<Record<string, string>>;
  sessionFilesRef: React.MutableRefObject<Set<string>>;
  getConf: () => AppConfig;
}

export type AskConfirm = (desc: string) => Promise<boolean>;

/* ---------- ファイルツリー ---------- */

export interface TreeNode {
  name: string;
  path: string;
  folder: boolean;
  children: TreeNode[];
}

export function buildTree(files: Record<string, string>): TreeNode[] {
  const root: TreeNode = { name: "", path: "", folder: true, children: [] };
  const folders = new Set(foldersOf(files));
  const ensure = (path: string, isFolder: boolean): TreeNode => {
    const parts = path.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.path === p);
      if (!child) {
        child = { name: parts[i], path: p, folder: i < parts.length - 1 || isFolder, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    return node;
  };
  for (const f of foldersOf(files)) ensure(f, true);
  for (const path of listPaths(files)) {
    if (path.endsWith("/.gitkeep")) continue;
    ensure(path, false);
  }
  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1))
      .map((n) => ({ ...n, children: sortNodes(n.children) }));
  return sortNodes(root.children);
}

/* ---------- 差分ビュー ---------- */

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = diffLines(before, after);
  const shown = lines.slice(0, 900);
  return (
    <div className="dev-diff">
      {shown.map((l, i) => (
        <div key={i} className={`dev-diff-line ${l.type}`}>
          <span className="no">{l.type === "add" ? "" : l.oldNo ?? ""}</span>
          <span className="no">{l.type === "del" ? "" : l.newNo ?? ""}</span>
          <span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
          <span className="tx">{l.text || " "}</span>
        </div>
      ))}
      {lines.length > shown.length && <div className="dev-diff-note">差分が大きいため先頭900行まで表示しています</div>}
    </div>
  );
}

/* ---------- ShellMain ---------- */

export function ShellMain(p: ShellProps) {
  const [sheet, setSheet] = useState<"new" | "github" | "model" | null>(null);
  const [confirmDesc, setConfirmDesc] = useState<string | null>(null);
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null);

  const askConfirm: AskConfirm = useCallback(
    (desc: string) =>
      new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve;
        setConfirmDesc(desc);
      }),
    [],
  );
  const answerConfirm = (ok: boolean) => {
    confirmResolveRef.current?.(ok);
    confirmResolveRef.current = null;
    setConfirmDesc(null);
  };

  const modelLabel =
    p.conf.provider === "auto"
      ? "Eluntra Auto"
      : `${providerDefOf(p.conf.provider)?.name || p.conf.provider} / ${selectedModel(p.conf.provider) || "モデル未選択"}`;

  const goBottom = (t: BottomTab) => {
    p.setBottomTab(p.bottomTab === t ? null : t);
  };
  const goMobile = (t: MobileTab) => {
    p.setMobileTab(t);
    if (t === "preview") p.setBottomTab("preview");
    if (t === "terminal") p.setBottomTab("terminal");
  };

  /* パネル・シート内でのプロジェクト選択は「開く」＝ワークスペースへ入る操作として扱う */
  const sp: ShellProps = { ...p, setActiveId: p.enterProject };
  const inDashboard = p.view === "dashboard";

  return (
    <div className="dev-root" data-mobile={p.mobileTab} data-view={p.view} data-chatwide={p.chatWide ? "1" : undefined}>
      <header className="dev-header">
        <a className="dev-back" href="./index.html">
          <DIcon name="back" className="dev-ic sm" /> Eluntra
        </a>
        <div className="dev-title">
          <Logo size={30} />
          <div className="dev-title-text">
            <span className="dev-appname">Eluntra Developer</span>
            <span className="dev-version">v7.2.7 ・ AIソフトウェア開発環境</span>
          </div>
        </div>
        <button
          type="button"
          className={`dev-dashbtn${inDashboard ? " on" : ""}`}
          onClick={() => p.goDashboard()}
          disabled={p.agentRunning}
          title={p.agentRunning ? "AI実行中はダッシュボードへ戻れません" : "ダッシュボード（プロジェクト一覧）へ戻る"}
        >
          <DIcon name="grid" className="dev-ic sm" /> ダッシュボード
        </button>
        {!inDashboard &&
          (p.project ? (
            <input
              className="dev-projname"
              value={p.project.name}
              onChange={(e) => p.updateProject(p.project!.id, (pr) => ({ ...pr, name: e.target.value }))}
              aria-label="プロジェクト名"
            />
          ) : (
            <span className="dev-projname-none">プロジェクト未選択</span>
          ))}
        {inDashboard && <span className="dev-projname-none">プロジェクト一覧</span>}
        <button type="button" className="dev-modelpill" onClick={() => setSheet("model")}>
          {modelLabel} <Icon name="chevron" className="ic sm" />
        </button>
      </header>

      {inDashboard ? (
        <DashboardView {...sp} askConfirm={askConfirm} onNewProject={() => setSheet("new")} onGitHub={() => setSheet("github")} />
      ) : (
        <>
          <div className="dev-main">
            <LeftPanel {...sp} askConfirm={askConfirm} onNewProject={() => setSheet("new")} onGitHub={() => setSheet("github")} />
            <CenterPanel {...sp} onNewProject={() => setSheet("new")} />
            <RightPanel {...sp} askConfirm={askConfirm} onOpenModel={() => setSheet("model")} />
          </div>

          <BottomPanel {...sp} />

          <nav className="dev-mobiletabs" aria-label="画面切替">
            <button type="button" className={p.mobileTab === "files" ? "on" : ""} onClick={() => goMobile("files")}>
              <DIcon name="folder" className="dev-ic" />
              <span>ファイル</span>
            </button>
            <button type="button" className={p.mobileTab === "editor" ? "on" : ""} onClick={() => goMobile("editor")}>
              <Icon name="code" className="ic" />
              <span>エディタ</span>
            </button>
            <button type="button" className={p.mobileTab === "ai" ? "on" : ""} onClick={() => goMobile("ai")}>
              <Icon name="bot" className="ic" />
              <span>AI</span>
            </button>
            <button type="button" className={p.mobileTab === "preview" ? "on" : ""} onClick={() => goMobile("preview")}>
              <DIcon name="monitor" className="dev-ic" />
              <span>プレビュー</span>
            </button>
            <button type="button" className={p.mobileTab === "terminal" ? "on" : ""} onClick={() => goMobile("terminal")}>
              <DIcon name="terminal" className="dev-ic" />
              <span>ターミナル</span>
            </button>
          </nav>

          <div className="dev-desktopbar">
            <button type="button" className={p.bottomTab === "terminal" ? "on" : ""} onClick={() => goBottom("terminal")}>
              <DIcon name="terminal" className="dev-ic sm" /> ターミナル
            </button>
            <button type="button" className={p.bottomTab === "preview" ? "on" : ""} onClick={() => goBottom("preview")}>
              <DIcon name="monitor" className="dev-ic sm" /> プレビュー
            </button>
            <button type="button" className={p.bottomTab === "problems" ? "on" : ""} onClick={() => goBottom("problems")}>
              <Icon name="alert" className="ic sm" /> 問題{p.markers.length ? `（${p.markers.length}）` : ""}
            </button>
            <button type="button" className={p.bottomTab === "database" ? "on" : ""} onClick={() => goBottom("database")}>
              <DIcon name="db" className="dev-ic sm" /> データベース
            </button>
            <span className="dev-desktopbar-note">実行環境はブラウザ内です（Node.js=WebContainer / Python=Pyodide / DB=SQLite・PostgreSQL）。</span>
          </div>
        </>
      )}

      {sheet === "new" && (
        <NewProjectSheet
          onClose={() => setSheet(null)}
          onCreate={(name, tpl) => {
            const pr = createProject(name, tpl);
            sp.commitProjects([pr, ...sp.projects]);
            sp.setActiveId(pr.id);
            setSheet(null);
          }}
        />
      )}
      {sheet === "github" && <GitHubSheet {...sp} onClose={() => setSheet(null)} askConfirm={askConfirm} />}
      {sheet === "model" && <ModelSheet onClose={() => setSheet(null)} />}

      {confirmDesc && (
        <div className="dev-confirm-back">
          <div className="dev-confirm-card" role="alertdialog" aria-label="変更の確認">
            <div className="dev-confirm-title">
              <Icon name="alert" className="ic sm" /> 確認が必要です
            </div>
            <p>{confirmDesc}</p>
            <div className="dev-confirm-btns">
              <button type="button" className="btn sm" onClick={() => answerConfirm(false)}>
                キャンセル
              </button>
              <button type="button" className="btn primary sm" onClick={() => answerConfirm(true)}>
                実行する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- ダッシュボード（プロジェクトのホーム） ---------- */

function DashboardView(props: ShellProps & { askConfirm: AskConfirm; onNewProject: () => void; onGitHub: () => void }) {
  const p = props;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const importJson = (file: File) => {
    void file.text().then((text) => {
      try {
        const j = JSON.parse(text) as Partial<DevProject>;
        if (!j.files || typeof j.files !== "object") throw new Error("files がありません");
        const pr = createProject(typeof j.name === "string" && j.name ? j.name : "読み込んだプロジェクト", "empty");
        pr.files = j.files as Record<string, string>;
        p.commitProjects([pr, ...p.projects]);
        p.setActiveId(pr.id);
      } catch {
        window.alert("プロジェクトJSONを読み込めませんでした。形式を確認してください。");
      }
    });
  };

  const startRename = (pr: DevProject) => {
    setRenamingId(pr.id);
    setRenameValue(pr.name);
  };
  const saveRename = (pr: DevProject) => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (!name || name === pr.name) return;
    p.updateProject(pr.id, (x) => ({ ...x, name }));
  };

  return (
    <main className="dev-dash">
      <div className="dev-dash-inner">
        <div className="dev-dash-head">
          <div>
            <h2 className="dev-dash-title">プロジェクト</h2>
            <p className="dev-dash-sub">
              プロジェクトを選んで開発を始めてください。AIチャットはプロジェクトごとに分かれて保存されます。
            </p>
          </div>
          <div className="dev-dash-actions">
            <button type="button" className="btn primary" onClick={props.onNewProject} disabled={p.agentRunning}>
              <Icon name="plus" className="ic sm" /> 新規プロジェクト
            </button>
            <button type="button" className="btn" onClick={() => importRef.current?.click()} disabled={p.agentRunning}>
              <Icon name="download" className="ic sm" /> JSON読み込み
            </button>
            <button type="button" className="btn" onClick={props.onGitHub} disabled={p.agentRunning}>
              <img src="./logos/conn-github.svg" alt="" width={16} height={16} /> GitHubから開く
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJson(f);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        {p.projects.length === 0 && (
          <div className="dev-dash-empty">
            まだプロジェクトがありません。「新規プロジェクト」から作成するか、GitHubのリポジトリを開いてください。
          </div>
        )}

        <div className="dev-dash-grid">
          {p.projects.map((pr) => {
            const chatCount = chatMessageCount(getProjectChat(p.chats, pr.id));
            const isLast = pr.id === p.lastActiveId && p.projects.length > 0;
            return (
              <article key={pr.id} className={`dev-card${isLast ? " last" : ""}`}>
                <div className="dev-card-head">
                  <DIcon name="folder" className="dev-ic" />
                  {renamingId === pr.id ? (
                    <input
                      className="dev-card-rename"
                      value={renameValue}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename(pr);
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      aria-label="プロジェクト名"
                    />
                  ) : (
                    <h3 className="dev-card-name">{pr.name}</h3>
                  )}
                  {isLast && <span className="dev-card-badge">前回開いた</span>}
                </div>
                <div className="dev-card-meta">
                  <span>{Object.keys(pr.files).length} ファイル</span>
                  <span>最終更新 {fmtRelative(pr.updatedAt)}</span>
                  <span>チャット {chatCount} 件</span>
                </div>
                {pr.github && (
                  <div className="dev-card-gh">
                    <DIcon name="branch" className="dev-ic sm" />
                    <span>
                      {pr.github.owner}/{pr.github.repo} @ {pr.github.branch}
                    </span>
                  </div>
                )}
                <div className="dev-card-btns">
                  {renamingId === pr.id ? (
                    <>
                      <button type="button" className="btn primary sm" onClick={() => saveRename(pr)}>
                        保存
                      </button>
                      <button type="button" className="btn sm" onClick={() => setRenamingId(null)}>
                        取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn primary sm"
                        onClick={() => p.enterProject(pr.id)}
                        disabled={p.agentRunning}
                        title={p.agentRunning ? "AI実行中は切り替えできません" : undefined}
                      >
                        開く
                      </button>
                      <button type="button" className="btn sm" onClick={() => startRename(pr)}>
                        名前変更
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={p.agentRunning}
                        title={p.agentRunning ? "AI実行中は削除できません" : undefined}
                        onClick={() => {
                          void props.askConfirm(`プロジェクト「${pr.name}」を削除しますか？チャット履歴も一緒に削除されます。この操作は取り消せません。`).then((ok) => {
                            if (ok) p.deleteProject(pr.id);
                          });
                        }}
                      >
                        削除
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </main>
  );
}

/* ---------- 左パネル ---------- */

function LeftPanel(props: ShellProps & { askConfirm: AskConfirm; onNewProject: () => void; onGitHub: () => void }) {
  const p = props;
  const project = p.project;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const importRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => (project ? buildTree(project.files) : []), [project]);
  const hits = useMemo(() => (project && query.trim() ? searchFiles(project.files, query) : []), [project, query]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const createEntry = (folder: boolean) => {
    if (!project) return;
    const name = newName.trim();
    if (!name) return;
    const base = targetDir ? `${targetDir}/` : "";
    try {
      if (folder) {
        const path = normalizePath(`${base}${name}/.gitkeep`);
        if (path in project.files) return;
        p.applyFileChange({ ...project.files, [path]: "" }, { path: normalizePath(`${base}${name}`), kind: "create", source: "user", detail: "フォルダ作成" });
        setExpanded((prev) => new Set(prev).add(normalizePath(`${base}${name}`)));
      } else {
        const path = normalizePath(`${base}${name}`);
        if (path in project.files) {
          p.openFile(path);
          return;
        }
        p.applyFileChange({ ...project.files, [path]: "" }, { path, kind: "create", source: "user" });
        p.openFile(path);
      }
      setNewName("");
    } catch {
      /* 入力不備は無視 */
    }
  };

  const doRename = (from: string) => {
    if (!project) return;
    const to = renameValue.trim();
    setRenaming(null);
    if (!to || to === from) return;
    try {
      const next = renamePath(project.files, from, to.includes("/") || from.includes("/") ? to : to);
      p.applyFileChange(next, { path: to, kind: "rename", source: "user", detail: `${from} → ${to}` });
      if (p.activePath === from) p.setActivePath(to);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    }
  };

  const doDelete = (path: string) => {
    if (!project) return;
    try {
      const next = deletePath(project.files, path);
      p.applyFileChange(next, { path, kind: "delete", source: "user" });
      if (p.activePath === path) p.setActivePath(null);
    } catch {
      /* ignore */
    }
    setDeleting(null);
  };

  const exportJson = () => {
    if (!project) return;
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.name || "eluntra-project"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (file: File) => {
    void file.text().then((text) => {
      try {
        const j = JSON.parse(text) as Partial<DevProject>;
        if (!j.files || typeof j.files !== "object") throw new Error("files がありません");
        const pr = createProject(typeof j.name === "string" && j.name ? j.name : "読み込んだプロジェクト", "empty");
        pr.files = j.files as Record<string, string>;
        p.commitProjects([pr, ...p.projects]);
        p.setActiveId(pr.id);
      } catch {
        window.alert("プロジェクトJSONを読み込めませんでした。形式を確認してください。");
      }
    });
  };

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const isOpen = expanded.has(node.path);
    const isActive = p.activePath === node.path;
    return (
      <div key={node.path}>
        <div
          className={`dev-tree-row${isActive ? " on" : ""}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (node.folder) {
              toggle(node.path);
              setTargetDir(node.path);
            } else {
              p.openFile(node.path);
            }
          }}
        >
          {node.folder ? (
            <>
              <span className={`dev-tree-chev${isOpen ? " open" : ""}`}>
                <Icon name="chevR" className="ic sm" />
              </span>
              <DIcon name="folder" className="dev-ic sm" />
            </>
          ) : (
            <DIcon name="file" className="dev-ic sm" />
          )}
          {renaming === node.path ? (
            <input
              className="dev-tree-rename"
              value={renameValue}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") doRename(node.path);
                if (e.key === "Escape") setRenaming(null);
              }}
              onBlur={() => doRename(node.path)}
            />
          ) : (
            <span className="dev-tree-name">{node.name}</span>
          )}
          <span className="dev-tree-acts" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              aria-label="名前変更"
              onClick={() => {
                setRenaming(node.path);
                setRenameValue(node.name);
              }}
            >
              <Icon name="pencil" className="ic sm" />
            </button>
            <button type="button" aria-label="削除" onClick={() => setDeleting(node.path)}>
              <Icon name="trash" className="ic sm" />
            </button>
          </span>
        </div>
        {deleting === node.path && (
          <div className="dev-tree-confirm" style={{ marginLeft: 8 + depth * 14 }}>
            「{node.name}」{node.folder ? "とその中身" : ""}を削除しますか？
            <button type="button" className="btn danger sm" onClick={() => doDelete(node.path)}>
              削除
            </button>
            <button type="button" className="btn sm" onClick={() => setDeleting(null)}>
              取消
            </button>
          </div>
        )}
        {node.folder && isOpen && node.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className="dev-left">
      <div className="dev-sec">
        <div className="dev-sec-head">
          <span>プロジェクト</span>
          <button type="button" className="btn primary sm" onClick={props.onNewProject} disabled={p.agentRunning} title={p.agentRunning ? "AI実行中は切り替えできません" : undefined}>
            <Icon name="plus" className="ic sm" /> 新規
          </button>
        </div>
        {p.projects.length === 0 && <div className="dev-empty-note">まだプロジェクトがありません。「新規」から作成してください。</div>}
        <div className="dev-proj-list">
          {p.projects.map((pr) => (
            <button
              key={pr.id}
              type="button"
              className={`dev-proj-item${pr.id === p.activeId ? " on" : ""}`}
              onClick={() => p.setActiveId(pr.id)}
              disabled={p.agentRunning && pr.id !== p.activeId}
              title={p.agentRunning && pr.id !== p.activeId ? "AI実行中は切り替えできません" : undefined}
            >
              <span className="t">{pr.name}</span>
              <span className="sub">{Object.keys(pr.files).length} ファイル</span>
            </button>
          ))}
        </div>
        {project && (
          <div className="dev-proj-acts">
            <button type="button" className="btn sm" onClick={exportJson}>
              <Icon name="download" className="ic sm" /> JSONで書き出し
            </button>
            <button type="button" className="btn sm" onClick={() => importRef.current?.click()} disabled={p.agentRunning} title={p.agentRunning ? "AI実行中は切り替えできません" : undefined}>
              読み込み
            </button>
            <button
              type="button"
              className="btn sm danger"
              disabled={p.agentRunning}
              title={p.agentRunning ? "AI実行中は削除できません" : undefined}
              onClick={() => {
                void props.askConfirm(`プロジェクト「${project.name}」を削除しますか？チャット履歴も一緒に削除されます。この操作は取り消せません。`).then((ok) => {
                  if (ok) p.deleteProject(project.id);
                });
              }}
            >
              削除
            </button>
            <input
              ref={importRef}
              type="file"
              accept="application/json"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importJson(f);
                e.target.value = "";
              }}
            />
          </div>
        )}
        <button type="button" className="dev-github-entry" onClick={props.onGitHub} disabled={p.agentRunning} title={p.agentRunning ? "AI実行中は切り替えできません" : undefined}>
          <img src="./logos/conn-github.svg" alt="" width={18} height={18} />
          <span>GitHub</span>
          <span className="sub">{githubConnected() ? "接続済み" : "未接続"}</span>
        </button>
      </div>

      {project && (
        <div className="dev-sec grow">
          <div className="dev-sec-head">
            <span>ファイル</span>
            <span className="dev-target">追加先: /{targetDir}</span>
          </div>
          <div className="dev-newentry">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="ファイル名 / フォルダ名"
              onKeyDown={(e) => {
                if (e.key === "Enter") createEntry(false);
              }}
              aria-label="新規ファイル・フォルダ名"
            />
            <button type="button" className="btn sm" onClick={() => createEntry(false)}>
              ファイル
            </button>
            <button type="button" className="btn sm" onClick={() => createEntry(true)}>
              フォルダ
            </button>
            <button type="button" className="btn sm" onClick={() => setTargetDir("")}>
              ルートへ
            </button>
          </div>
          <div className="dev-tree">{tree.map((n) => renderNode(n, 0))}</div>
          <div className="dev-searchbox">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="プロジェクト内を検索"
              aria-label="プロジェクト内検索"
            />
            {query.trim() && (
              <div className="dev-search-results">
                {hits.length === 0 && <div className="dev-empty-note">一致なし</div>}
                {hits.slice(0, 50).map((h, i) => (
                  <button key={i} type="button" className="dev-search-hit" onClick={() => p.openFile(h.path)}>
                    <span className="loc">
                      {h.path}:{h.line}
                    </span>
                    <span className="tx">{h.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <details className="dev-changelog">
            <summary>変更履歴（直近）</summary>
            {(project.changeLog || []).slice(0, 30).map((c, i) => (
              <div key={i} className="dev-changelog-row">
                <span className="time">{fmtTime(c.at)}</span>
                <span className="kind">{c.kind}</span>
                <span className="path">{c.detail || c.path}</span>
                <span className="src">{c.source === "ai" ? "AI" : c.source === "github" ? "GitHub" : "あなた"}</span>
              </div>
            ))}
            {(project.changeLog || []).length === 0 && <div className="dev-empty-note">まだ変更がありません</div>}
          </details>
        </div>
      )}
    </aside>
  );
}

/* ---------- 中央パネル（エディター） ---------- */

function CenterPanel(props: ShellProps & { onNewProject: () => void}) {
const p = props;
const project = p.project;

if (!project) {
return (
<section className="dev-center">
<div className="dev-center-empty">
<Logo size={72} />
<h2>Eluntra Developer</h2>
<p>プロジェクトを作成すると、ファイル編集・AI開発・ターミナル・プレビューが使えます。</p>
<button type="button" className="btn primary" onClick={props.onNewProject}>
<Icon name="plus" className="ic sm" /> プロジェクトを作成
</button>
</div>
</section>
);
}

const showingPair = p.diffPair;
const baseline = p.activePath? p.baselineRef.current[p.activePath]?? "": "";

return (
<section className="dev-center">
<div className="dev-tabs" role="tablist">
{p.openTabs.map((path) => (
<button
key={path}
type="button"
role="tab"
aria-selected={p.activePath === path}
className={`dev-tab${p.activePath === path? " on": ""}`}
onClick={() => p.setActivePath(path)}
>
<span className="t">{path.split("/").pop()}</span>
<span
className="x"
role="button"
aria-label="タブを閉じる"
onClick={(e) => {
e.stopPropagation();
p.flushEdit();
p.closeTab(path);
}}
>
<Icon name="x" className="ic sm" />
</span>
</button>
))}
{p.openTabs.length === 0 && <span className="dev-tabs-none">ファイルツリーからファイルを選んでください</span>}
</div>
<div className="dev-editorbar">
<span className="dev-editorpath">{p.activePath || "—"}</span>
<div className="dev-editoracts">
{p.activePath?.endsWith(".py") && (
<button
type="button"
className="btn sm primary"
onClick={() => {
p.flushEdit();
p.setBottomTab("terminal");
p.setMobileTab("terminal");
termBus.requestRunFile(p.activePath!);
}}
>
<DIcon name="play" className="dev-ic sm" /> 実行
</button>
)}
<button type="button" className="btn sm" onClick={() => p.editorApiRef.current?.find()} disabled={!p.activePath}>
検索・置換
</button>
<button type="button" className="btn sm" onClick={() => p.editorApiRef.current?.format()} disabled={!p.activePath}>
整形
</button>
<button type="button" className="btn sm" onClick={p.doUndo} disabled={!p.activePath}>
元に戻す
</button>
<button type="button" className="btn sm" onClick={p.doRedo} disabled={!p.activePath}>
やり直し
</button>
<button
type="button"
className={`btn sm${p.showDiff? " primary": ""}`}
onClick={() => p.setShowDiff(!p.showDiff)}
disabled={!p.activePath}
>
差分
</button>
</div>
</div>
<div className="dev-editor-wrap">
{showingPair? (
<div className="dev-pairdiff">
<div className="dev-pairdiff-head">
<span>{showingPair.title}</span>
<button type="button" className="btn sm" onClick={() => p.setDiffPair(null)}>
エディターに戻る
</button>
</div>
<DiffView before={showingPair.before} after={showingPair.after} />
</div>
): p.showDiff && p.activePath? (
<DiffView before={baseline} after={p.activeContent} />
): (
<Editor
path={p.activePath}
value={p.activeContent}
dark={p.theme === "dark"}
onChange={p.onEditorChange}
onReady={(api) => {
p.editorApiRef.current = api;
}}
onMarkers={p.setMarkers}
/>
)}
</div>
</section>
);
}

/* ---------- AIパネル ---------- */

/** イベントの入力形（seq は pushEvent が採番する） */
type TimelineItem = Omit<DevChatEvent, "seq">;
type StreamItem = DevChatItem;

let wcMountedProjectId = "";

export async function ensureWcMounted(project: DevProject | null): Promise<void> {
  await wcService.ensureBoot();
  if (project && wcMountedProjectId !== project.id) {
    await wcService.mountProject(project.files);
    wcMountedProjectId = project.id;
  }
}

function RightPanel(props: ShellProps & { askConfirm: AskConfirm; onOpenModel: () => void }) {
  const p = props;
  const [mode, setMode] = useState<DevMode>("auto");
  const [input, setInput] = useState("");
  /* チャットはプロジェクトごとに保持する。owner は items が属するプロジェクトID */
  const [streamState, setStreamState] = useState<{ owner: string; items: StreamItem[] }>({ owner: "", items: [] });
  const stream = streamState.items;
  const [running, setRunning] = useState(false);
  /* 実行中ステータスバー用：開始時刻＋1秒ティック（イベントが来なくても経過秒数が進む。v7.2.7） */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNowTs(Date.now());
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);
  const [undone, setUndone] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const projectRef = useRef(p.project);
  projectRef.current = p.project;
  const streamRef = useRef<HTMLDivElement>(null);
  const seqRef = useRef(1);
  const runningRef = useRef(false);
  runningRef.current = running;
  const chatDataRef = useRef(p.chatData);
  chatDataRef.current = p.chatData;
  const onChatChangeRef = useRef(p.onChatChange);
  onChatChangeRef.current = p.onChatChange;
  const setAgentRunning = p.setAgentRunning;

  const setStream = useCallback((updater: (prev: StreamItem[]) => StreamItem[]) => {
    setStreamState((prev) => ({ owner: prev.owner, items: updater(prev.items) }));
  }, []);

  /* 保存: 実行中は切り捨てず、終了後に上限で切り捨てる */
  const persist = useCallback((owner: string, items: StreamItem[]) => {
    if (!owner) return;
    const data = splitChatItems(items);
    onChatChangeRef.current(owner, runningRef.current ? data : trimChat(data));
  }, []);

  const activeProjectId = p.project?.id || "";

  /* プロジェクト切替時: 前のプロジェクトの最終状態を保存し、そのプロジェクトのチャットを読み込む */
  useLayoutEffect(() => {
    if (streamState.owner === activeProjectId) return;
    if (streamState.owner) persist(streamState.owner, streamState.items);
    const data = chatDataRef.current;
    seqRef.current = nextChatSeq(data);
    setStreamState({ owner: activeProjectId, items: interleaveChat(data) });
    setUndone(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  /* チャットの変更をプロジェクト別に保存する */
  useEffect(() => {
    if (!streamState.owner) return;
    persist(streamState.owner, streamState.items);
  }, [streamState, running, persist]);

  /* 実行中フラグをシェルへ伝える（切替・ダッシュボード復帰の無効化に使う） */
  useEffect(() => {
    setAgentRunning(running);
  }, [running, setAgentRunning]);

  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stream, running]);

  const pushMsg = useCallback(
    (role: "user" | "assistant" | "system", content: string) => {
      const id = `m${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const seq = seqRef.current++;
      setStream((prev) => [...prev, { type: "msg", msg: { id, role, content, seq } }]);
    },
    [setStream],
  );

  const pushEvent = useCallback(
    (item: TimelineItem) => {
      const seq = seqRef.current++;
      setStream((prev) => [...prev.slice(-500), { type: "event", event: { ...item, seq } }]);
    },
    [setStream],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    wcService.stopCurrent();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || running) return;
    const project = projectRef.current;
    if (!project) {
      pushMsg("system", "プロジェクトが選択されていません。左のパネルでプロジェクトを作成・選択してください。");
      return;
    }
    setInput("");
    pushMsg("user", text);

    const confNow = p.getConf();
    let provider: import("../lib/types").ProviderDef | null = null;
    let model = "";
    if (confNow.provider === "auto") {
      const choice = resolveAuto(text);
      if (!choice) {
        pushMsg("system", "接続済みのAIがありません。本体（Eluntra）の設定でAPIキーを設定してから、もう一度お試しください。");
        return;
      }
      provider = choice.provider;
      model = choice.model;
      pushEvent({ id: `e${Date.now()}`, kind: "note", label: `Eluntra Auto: ${choice.reason}`, at: Date.now() });
    } else {
      provider = providerDefOf(confNow.provider) || null;
      model = selectedModel(confNow.provider);
      if (!provider) {
        pushMsg("system", "選択中のプロバイダーが見つかりません。本体の設定で選び直してください。");
        return;
      }
      if (!hasCredentials(provider.id)) {
        pushMsg(
          "system",
          `${provider.name} のAPIキーが未設定です。本体（Eluntra）の「設定 → APIプロバイダー」でキーを設定してから、もう一度お試しください。`,
        );
        return;
      }
    }

    const history: ChatMessage[] = stream
      .filter((s): s is Extract<StreamItem, { type: "msg" }> => s.type === "msg" && (s.msg.role === "user" || s.msg.role === "assistant"))
      .map((s) => ({ role: s.msg.role as "user" | "assistant", content: s.msg.content }));

    const ctl = new AbortController();
    abortRef.current = ctl;
    setRunStartedAt(Date.now());
    setRunning(true);
    try {
      const result = await runDevAgent({
        provider,
        model,
        mode,
        history,
        userText: text,
        ctx: {
          getFiles: () => projectRef.current?.files || {},
          applyFiles: (nextFiles, change) => {
            const cur = projectRef.current;
            if (!cur) return;
            p.updateProject(cur.id, (pr) => {
              let next: DevProject = { ...pr, files: nextFiles, updatedAt: Date.now() };
              if (change) {
                next = {
                  ...next,
                  changeLog: [
                    { at: Date.now(), path: change.path, kind: change.kind, source: "ai" as const },
                    ...(next.changeLog || []),
                  ].slice(0, 100),
                };
              }
              return next;
            });
          },
          confirm: props.askConfirm,
          termExec: async (command: string) => {
            const parsedPy = parsePythonCommand(command);
            if (parsedPy.kind !== "other") {
              if (parsedPy.kind === "python-repl") {
                return "対話モード（python単体）はエージェントからは使えません。python -c \"...\" か、ファイルを作成して python file.py で実行してください。";
              }
              try {
                const filesNow = projectRef.current?.files || {};
                if (parsedPy.kind === "pip-install") {
                  const r = await pyService.pipInstall(parsedPy.packages);
                  return [`$ ${command}（Python / Pyodide）`, r.error ? `micropip エラー: ${r.error}` : r.output.trim() || "インストールしました"].join("\n");
                }
                const res =
                  parsedPy.kind === "python-file"
                    ? await pyService.runFile(filesNow, parsedPy.path, parsedPy.args)
                    : await pyService.runCode(filesNow, parsedPy.kind === "python-code" ? parsedPy.code : "");
                if (res.changes.length) {
                  const cur = projectRef.current;
                  if (cur) {
                    const applied = applyPyChanges(cur.files, res.changes);
                    if (applied.touched.length) {
                      p.updateProject(cur.id, (pr) => ({
                        ...pr,
                        files: applied.files,
                        changeLog: [
                          { at: Date.now(), path: applied.touched[0], kind: "edit" as const, source: "ai" as const, detail: `Python実行で${applied.touched.length}件変更` },
                          ...(pr.changeLog || []),
                        ].slice(0, 100),
                      }));
                    }
                  }
                }
                return [
                  `$ ${command}（Python / Pyodide）`,
                  res.output.trim() ? res.output.trim().slice(-6000) : "（出力なし）",
                  res.error ? `エラー: ${res.error.slice(0, 2000)}` : "（終了コード: 0）",
                ].join("\n");
              } catch (e) {
                return `Pythonは利用できません: ${pyService.errorReason || (e instanceof Error ? e.message : String(e))}`;
              }
            }
            try {
              await ensureWcMounted(projectRef.current);
            } catch (e) {
              return `ターミナル（Node.js）は利用できません: ${wcService.errorReason || (e instanceof Error ? e.message : String(e))}。Pythonコマンド（python file.py 等）は Pyodide で実行できます。`;
            }
            const res = await wcService.exec(command, { timeoutMs: 120_000 });
            const out = res.output.trim();
            return [
              `$ ${command}`,
              out ? out.slice(-6000) : "（出力なし）",
              res.timedOut ? "（120秒でタイムアウトし、停止しました）" : `（終了コード: ${res.code ?? "不明"}）`,
            ].join("\n");
          },
          previewInfo: () => {
            if (wcService.previewUrl) return `開発サーバーが起動しています。プレビューURL: ${wcService.previewUrl}`;
            const cur = projectRef.current;
            if (cur && "index.html" in cur.files) return "開発サーバーは未起動です。静的プレビュー（index.html）が利用できます。";
            return "プレビューは未起動です。ターミナルで開発サーバー（npm run dev）を起動するとURLが発行されます（WebContainerが必要）";
          },
          dbList: async () => {
            const cur = projectRef.current;
            if (!cur) return "プロジェクトが選択されていません";
            const metas = await dbService.listDbs(cur.id);
            if (!metas.length) return "このプロジェクトにはデータベースがまだありません。データベースはユーザーが下部パネルの「データベース」タブで作成します（あなたは作成できません）。必要なら最終報告で作成を依頼してください。";
            return metas.map((m) => `${m.name}（${m.engine === "sqlite" ? "SQLite" : "PostgreSQL"}）`).join("\n");
          },
          dbSchema: async (name: string) => {
            const cur = projectRef.current;
            if (!cur) return "プロジェクトが選択されていません";
            const metas = await dbService.listDbs(cur.id);
            const meta = metas.find((m) => m.name === name);
            if (!meta) return `データベース「${name}」がありません。db_list で確認してください。`;
            const tables = await dbService.schema(meta);
            return formatSchemaForAgent(tables);
          },
          dbQuery: async (name: string, sql: string) => {
            const cur = projectRef.current;
            if (!cur) return "プロジェクトが選択されていません";
            const metas = await dbService.listDbs(cur.id);
            const meta = metas.find((m) => m.name === name);
            if (!meta) return `データベース「${name}」がありません。db_list で確認してください。`;
            const outcome = await dbService.execSql(meta, sql);
            return formatOutcomeForAgent(outcome, meta.name);
          },
          contextNote: () => {
            const cur = projectRef.current;
            const dbs: DbMeta[] = cur ? dbService.cachedList(cur.id) : [];
            return [
              "実行環境: Node.js は WebContainer、Python は Pyodide（CPython のWASM版）で実際に実行できます。python file.py / python -c / pip install（純Pythonのみ）が使えます。",
              dbs.length
                ? `利用可能なデータベース: ${dbs.map((m) => `${m.name}（${m.engine === "sqlite" ? "SQLite" : "PostgreSQL"}）`).join("、")}。db_list / db_schema / db_query ツールで操作できます。`
                : "データベースはまだ作成されていません（作成はユーザー操作です）。",
            ].join("\n");
          },
          sessionFiles: p.sessionFilesRef.current,
          signal: ctl.signal,
          onEvent: (e: AgentEvent) => {
            if (e.kind === "change") {
              pushEvent({ id: e.change.id, kind: "change", label: e.change.path, change: e.change, at: e.change.at });
            } else if (e.kind === "tool") {
              pushEvent({
                id: `t${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                kind: "tool",
                label: e.tool,
                detail: e.detail,
                output: e.output || undefined,
                at: Date.now(),
              });
            } else if (e.kind === "step") {
              pushEvent({ id: `s${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: "step", label: e.label, step: e.step, max: e.max, at: Date.now() });
            } else if (e.kind === "note") {
              pushEvent({ id: `n${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: "note", label: e.label, at: Date.now() });
            }
          },
        },
      });
      const body = [result.text, result.stopped ? `${result.stopped}` : ""].filter(Boolean).join("\n\n");
      pushMsg("assistant", body || "（報告がありませんでした）");
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        pushMsg("system", "停止しました。");
      } else {
        pushMsg("system", `実行できませんでした: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setRunning(false);
      setRunStartedAt(null);
      abortRef.current = null;
    }
  }, [input, running, mode, p, props.askConfirm, pushMsg, pushEvent, stream]);

  /* 実行中ステータスバーの表示内容（最新の手順・待機カウントダウン・実行中ツール） */
  const runElapsed = running && runStartedAt ? Math.max(0, Math.floor((nowTs - runStartedAt) / 1000)) : 0;
  let lastStepEv: { label: string; step?: number; max?: number } | null = null;
  for (const s of stream) {
    if (s.type === "event" && s.event.kind === "step") {
      lastStepEv = { label: s.event.label, step: s.event.step, max: s.event.max };
    }
  }
  let waitRemain: number | null = null;
  let runLabel = lastStepEv?.label || "タスクを分析中";
  {
    const lastItem = stream[stream.length - 1];
    if (running && lastItem?.type === "event" && lastItem.event.kind === "note") {
      const mm = lastItem.event.label.match(/レート制限のため待機中（約(\d+)秒）/);
      if (mm) {
        const remain = parseInt(mm[1], 10) - Math.floor((nowTs - lastItem.event.at) / 1000);
        if (remain > 0) waitRemain = remain;
      } else if (!lastStepEv) {
        runLabel = lastItem.event.label;
      }
    }
  }
  /* 結果がまだ届いていないツール開始エントリ（同じ呼び出しの変更カードは読み飛ばす） */
  let activeToolId: string | null = null;
  if (running) {
    for (let i = stream.length - 1; i >= 0; i--) {
      const s = stream[i];
      if (s.type !== "event") break;
      if (s.event.kind === "change") continue;
      if (s.event.kind === "tool" && !s.event.output) activeToolId = s.event.id;
      break;
    }
  }

  const undoChange = (change: ChangeRecord) => {
    const cur = projectRef.current;
    if (!cur) return;
    const next = revertChange(cur.files, change);
    p.updateProject(cur.id, (pr) => ({
      ...pr,
      files: next,
      changeLog: [
        { at: Date.now(), path: change.path, kind: "edit" as const, source: "user" as const, detail: "AIの変更を元に戻した" },
        ...(pr.changeLog || []),
      ].slice(0, 100),
    }));
    setUndone((prev) => new Set(prev).add(change.id));
  };

  return (
    <aside className="dev-right">
      <div className="dev-sec-head" style={{ padding: "10px 12px 0" }}>
        <span>AI Developer</span>
        <span className="dev-head-btns">
          <button
            type="button"
            className="btn sm"
            onClick={() => p.setChatWide(!p.chatWide)}
            aria-pressed={p.chatWide}
            title={p.chatWide ? "チャットを通常の幅に戻す" : "チャットを広げて使う"}
          >
            <DIcon name={p.chatWide ? "shrink" : "expand"} className="dev-ic sm" /> {p.chatWide ? "戻す" : "広げる"}
          </button>
          <button type="button" className="btn sm" onClick={props.onOpenModel}>
            モデル変更
          </button>
        </span>
      </div>
      <div className="dev-chat-proj">
        {p.project ? `「${p.project.name}」のチャット（プロジェクトごとに保存されます）` : "プロジェクト未選択"}
      </div>
      <div className="dev-modes" role="tablist" aria-label="開発モード">
        {DEV_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={mode === m.id}
            className={`dev-mode${mode === m.id ? " on" : ""}`}
            title={m.desc}
            onClick={() => setMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="dev-mode-desc">
        {DEV_MODES.find((m) => m.id === mode)?.desc}
        {READONLY_MODES.has(mode) ? "（このモードではファイルを変更しません）" : ""}
      </div>
      {running && (
        <div className="dev-runbar" role="status" aria-live="polite">
          <span className="dev-spinner" aria-hidden="true" />
          {lastStepEv?.step ? (
            <span className="dev-runbar-step">
              {lastStepEv.step}/{lastStepEv.max ?? 25}
            </span>
          ) : null}
          <span className="dev-runbar-label">
            {waitRemain !== null ? `レート制限のため待機中（残り約${waitRemain}秒）` : runLabel}
          </span>
          <span className="dev-runbar-time">{runElapsed}秒</span>
        </div>
      )}
      <div className="dev-stream" ref={streamRef}>
        {stream.length === 0 && (
          <div className="dev-empty-note" style={{ padding: 12 }}>
            作りたいものを伝えてください。プロジェクトを調査し、計画・実装・動作確認まで進めます。実行していない作業を完了とは表示しません。
          </div>
        )}
        {stream.map((s) => {
          if (s.type === "msg") {
            return (
              <div key={s.msg.id} className={`dev-msg ${s.msg.role}`}>
                <div className="dev-msg-role">{s.msg.role === "user" ? "あなた" : s.msg.role === "assistant" ? "AI Developer" : "案内"}</div>
                <div className="dev-msg-body">{s.msg.content}</div>
              </div>
            );
          }
          const it = s.event;
          if (it.kind === "change" && it.change) {
            const st = diffStat(it.change.before ?? "", it.change.after ?? "");
            const done = undone.has(it.change.id);
            return (
              <div key={s.event.id} className="dev-changecard">
                <div className="dev-changecard-head">
                  <Icon name="doc" className="ic sm" />
                  <span className="path">{it.change.path}</span>
                  <span className="kind">
                    {it.change.kind === "create" ? "作成" : it.change.kind === "delete" ? "削除" : "編集"}
                  </span>
                  <span className="stat">
                    +{st.added} / −{st.removed}
                  </span>
                </div>
                <div className="dev-changecard-btns">
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() =>
                      p.setDiffPair({
                        title: `${it.change!.path} の変更`,
                        before: it.change!.before ?? "",
                        after: it.change!.after ?? "",
                      })
                    }
                  >
                    差分を見る
                  </button>
                  <button type="button" className="btn sm" disabled={done} onClick={() => undoChange(it.change!)}>
                    {done ? "元に戻し済み" : "この変更を元に戻す"}
                  </button>
                </div>
              </div>
            );
          }
          if (it.kind === "tool") {
            const activeTool = it.id === activeToolId;
            return (
              <details key={s.event.id} className={`dev-tool${activeTool ? " active" : ""}`}>
                <summary>
                  {activeTool ? <span className="dev-spinner sm" aria-hidden="true" /> : <DIcon name="terminal" className="dev-ic sm" />} {it.label}
                  {it.detail ? ` — ${it.detail}` : ""}
                  {activeTool ? <span className="dev-tool-active-label">実行中…</span> : null}
                </summary>
                {it.output && <pre>{it.output}</pre>}
              </details>
            );
          }
          return (
            <div key={s.event.id} className="dev-step">
              <span className="time">{fmtTime(it.at)}</span>
              {it.step ? <span className="time">{it.step}/{it.max ?? ""}</span> : null} {it.label}
            </div>
          );
        })}
      </div>
      <div className="dev-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onInput={(e) => {
            const ta = e.currentTarget;
            ta.style.height = "auto";
            ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
          }}
          placeholder={p.project ? "作りたいもの・直したいことを入力" : "プロジェクトを選んでください"}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
          }}
          aria-label="AIへの指示"
        />
        <div className="dev-composer-btns">
          <span className="dev-composer-note">Ctrl+Enterで送信</span>
          {running ? (
            <button type="button" className="btn danger sm" onClick={stop}>
              <Icon name="stop" className="ic sm" /> 停止
            </button>
          ) : (
            <button type="button" className="btn primary sm" onClick={() => void send()} disabled={!input.trim()}>
              送信
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/* ---------- 下部パネル ---------- */

function BottomPanel(p: ShellProps) {
const tab = p.bottomTab;
const [sub, setSub] = useState<"term" | "db">("term");
return (
<section className={`dev-bottom${tab? " open": ""}`} aria-label="下部パネル">
{tab === "terminal" && (
<>
<div className="dev-subtabs" role="tablist" aria-label="ターミナルとデータベース">
<button type="button" role="tab" aria-selected={sub === "term"} className={sub === "term"? "on": ""} onClick={() => setSub("term")}>
ターミナル
</button>
<button type="button" role="tab" aria-selected={sub === "db"} className={sub === "db"? "on": ""} onClick={() => setSub("db")}>
データベース
</button>
</div>
{sub === "term"? <TerminalPane {...p} />: <DbPane {...p} />}
</>
)}
{tab === "database" && <DbPane {...p} />}
{tab === "preview" && <PreviewPane {...p} />}
{tab === "problems" && <ProblemsPane {...p} />}
{tab === null && (
<div className="dev-bottom-mobile-default">
<TerminalPane {...p} />
</div>
)}
</section>
);
}

function useWcTick(): void {
const [, setTick] = useState(0);
useEffect(() => {
const off1 = wcService.onState(() => setTick((n) => n + 1));
const off2 = wcService.onPreview(() => setTick((n) => n + 1));
return () => {
off1();
off2();
};
}, []);
}

function TerminalPane(p: ShellProps) {
useWcTick();
const [, setPyTick] = useState(0);
useEffect(() => pyService.onState(() => setPyTick((n) => n + 1)), []);
const [text, setText] = useState("");
const [cmd, setCmd] = useState("");
const [running, setRunning] = useState(false);
const [repl, setRepl] = useState(false);
const runningRef = useRef(false);
const preRef = useRef<HTMLPreElement>(null);
const projectRef = useRef(p.project);
projectRef.current = p.project;
const propsRef = useRef(p);
propsRef.current = p;

useEffect(() => {
const el = preRef.current;
if (el) el.scrollTop = el.scrollHeight;
}, [text]);

const append = useCallback((chunk: string) => {
setText((prev) => (prev + chunk).slice(-120_000));
}, []);

useEffect(() => termBus.onAppend(append), [append]);

const applyChanges = useCallback(
(changes: PyChange[]) => {
const cur = projectRef.current;
if (!cur || !changes.length) return;
const applied = applyPyChanges(cur.files, changes);
if (!applied.touched.length) return;
propsRef.current.applyFileChange(applied.files, {
path: applied.touched[0],
kind: "edit",
source: "user",
detail: `Python実行で${applied.touched.length}件のファイルを変更: ${applied.touched.slice(0, 5).join(", ")}${applied.touched.length > 5? " ほか": ""}`,
});
append(`[Python: ${applied.touched.length}件のファイルをプロジェクトへ反映しました: ${applied.touched.join(", ")}]\n`);
},
[append],
);

const runPythonParsed = useCallback(
async (parsed: ParsedTermCommand) => {
const files = projectRef.current?.files || {};
try {
if (parsed.kind === "python-repl") {
setRepl(true);
append("Python対話モードを開始しました（変数は保持されます）。終了するには exit() と入力してください。\n");
return;
}
if (parsed.kind === "pip-install") {
append("micropip でインストールしています（純Pythonパッケージのみ対応）…\n");
const res = await pyService.pipInstall(parsed.packages, append);
if (res.error) append(`micropip エラー: ${res.error}\n`);
return;
}
const res =
parsed.kind === "python-file"
? await pyService.runFile(files, parsed.path, parsed.args, append)
: await pyService.runCode(files, parsed.kind === "python-code"? parsed.code: "", { onOutput: append});
if (res.error) append(`${res.error}\n`);
applyChanges(res.changes);
} catch (e) {
append(`Pythonを利用できません: ${pyService.errorReason || (e instanceof Error? e.message: String(e))}\n`);
}
},
[append, applyChanges],
);

const runFileExternal = useCallback(
async (path: string) => {
if (runningRef.current) return;
propsRef.current.flushEdit();
append(`\n$ python ${path}\n`);
runningRef.current = true;
setRunning(true);
try {
const res = await pyService.runFile(projectRef.current?.files || {}, path, [], append);
if (res.error) append(`${res.error}\n`);
applyChanges(res.changes);
} catch (e) {
append(`Pythonを利用できません: ${pyService.errorReason || (e instanceof Error? e.message: String(e))}\n`);
}
runningRef.current = false;
setRunning(false);
},
[append, applyChanges],
);

useEffect(() => termBus.onRunFile((path) => void runFileExternal(path)), [runFileExternal]);

const run = useCallback(async () => {
const command = cmd.trim();
if (!command || runningRef.current) return;
setCmd("");
if (repl) {
append(`\n>>> ${command}\n`);
if (command === "exit()" || command === "quit()") {
setRepl(false);
append("Python対話モードを終了しました。\n");
return;
}
runningRef.current = true;
setRunning(true);
try {
const res = await pyService.runSnippet(command, append);
if (res.error) append(`${res.error}\n`);
} catch (e) {
append(`Pythonを利用できません: ${pyService.errorReason || (e instanceof Error? e.message: String(e))}\n`);
}
runningRef.current = false;
setRunning(false);
return;
}
append(`\n$ ${command}\n`);
const parsed = parsePythonCommand(command);
if (parsed.kind !== "other") {
runningRef.current = true;
setRunning(true);
await runPythonParsed(parsed);
runningRef.current = false;
setRunning(false);
return;
}
runningRef.current = true;
setRunning(true);
try {
await ensureWcMounted(projectRef.current);
} catch (e) {
append(`ターミナル（Node.js）を利用できません: ${wcService.errorReason || (e instanceof Error? e.message: String(e))}\n`);
runningRef.current = false;
setRunning(false);
return;
}
try {
const res = await wcService.exec(command, { onOutput: append});
append(`\n[終了コード ${res.code?? "不明"}${res.timedOut? "（タイムアウトで停止）": ""}]\n`);
} catch (e) {
append(`実行できませんでした: ${e instanceof Error? e.message: String(e)}\n`);
}
runningRef.current = false;
setRunning(false);
}, [cmd, repl, append, runPythonParsed]);

const state = wcService.state;
const pyState = pyService.state;
return (
<div className="dev-pane terminal">
<div className="dev-pane-head">
<span>
<DIcon name="terminal" className="dev-ic sm" /> ターミナル（Node.js / Python）
</span>
<span className="dev-pane-state">
Node: {state === "ready"? "起動済み": state === "booting"? "起動中…": state === "error"? `利用不可`: "未起動"}
{" ／ Python: "}
{pyState === "ready"? `利用可能（CPython ${pyService.version || ""}）`: pyState === "loading"? "読み込み中…": pyState === "error"? `利用不可: ${pyService.errorReason}`: "未読み込み（pythonコマンド実行時に読み込みます）"}
{state === "error" && ` ／ Nodeを利用できません: ${wcService.errorReason}`}
</span>
<span className="dev-pane-btns">
{running && (
<button type="button" className="btn danger sm" onClick={() => wcService.stopCurrent()}>
停止
</button>
)}
<button type="button" className="btn sm" onClick={() => setText("")}>
クリア
</button>
<button type="button" className="btn sm dev-pane-close" onClick={() => p.setBottomTab(null)}>
閉じる
</button>
</span>
</div>
<pre className="dev-term-out" ref={preRef}>
{text || "コマンドを実行すると、ここに出力が表示されます。\nNode.js の例: npm install / npm run dev / node -v / ls\nPython の例: python hello.py / python -c \"print(1+2)\" / python（対話モード） / pip install <純Pythonパッケージ>\n（本物のOSシェルではなく、ブラウザ内の実行環境です。PythonはPyodide＝CPythonのWASM版で動き、ファイルはプロジェクトと同期されます）"}
</pre>
<div className="dev-term-input">
<span>{repl? ">>>": "$"}</span>
<input
value={cmd}
onChange={(e) => setCmd(e.target.value)}
onKeyDown={(e) => {
if (e.key === "Enter") void run();
}}
placeholder={repl? "Pythonコードを入力（exit()で終了）": "コマンドを入力してEnter"}
aria-label="ターミナルコマンド"
/>
<button type="button" className="btn primary sm" onClick={() => void run()} disabled={running ||!cmd.trim()}>
実行
</button>
</div>
</div>
);
}

function PreviewPane(p: ShellProps) {
useWcTick();
const [source, setSource] = useState<"server" | "static">("server");
const [viewport, setViewport] = useState<"pc" | "tablet" | "mobile">("pc");
const [reloadKey, setReloadKey] = useState(0);
const [busy, setBusy] = useState(false);
const [log, setLog] = useState("");
const files = p.project?.files || {};
const projectRef = useRef(p.project);
projectRef.current = p.project;

const staticDoc = useMemo(() => buildStaticPreview(files), [files]);
const url = wcService.previewUrl;
const width = viewport === "mobile"? 390: viewport === "tablet"? 768: undefined;

const startServer = async () => {
setBusy(true);
try {
await ensureWcMounted(projectRef.current);
await wcService.startDevServer((chunk) => setLog((prev) => (prev + chunk).slice(-20_000)));
setLog((prev) => prev + "\n[開発サーバーを起動しました。URLが発行されるとプレビューに表示されます]\n");
} catch (e) {
setLog(`開発サーバーを起動できません: ${wcService.errorReason || (e instanceof Error? e.message: String(e))}`);
}
setBusy(false);
};

return (
<div className="dev-pane preview">
<div className="dev-pane-head">
<span>
<DIcon name="monitor" className="dev-ic sm" /> プレビュー
</span>
<span className="dev-preview-toggle">
<button type="button" className={source === "server"? "on": ""} onClick={() => setSource("server")}>
開発サーバー
</button>
<button type="button" className={source === "static"? "on": ""} onClick={() => setSource("static")}>
静的プレビュー
</button>
</span>
<span className="dev-pane-btns">
<button type="button" className={viewport === "mobile"? "btn sm primary": "btn sm"} onClick={() => setViewport("mobile")} aria-label="モバイル表示">
<DIcon name="phone" className="dev-ic sm" />
</button>
<button type="button" className={viewport === "tablet"? "btn sm primary": "btn sm"} onClick={() => setViewport("tablet")} aria-label="タブレット表示">
<DIcon name="tablet" className="dev-ic sm" />
</button>
<button type="button" className={viewport === "pc"? "btn sm primary": "btn sm"} onClick={() => setViewport("pc")} aria-label="PC表示">
<DIcon name="monitor" className="dev-ic sm" />
</button>
<button type="button" className="btn sm" onClick={() => setReloadKey((k) => k + 1)}>
<Icon name="refresh" className="ic sm" /> 再読み込み
</button>
<button type="button" className="btn sm dev-pane-close" onClick={() => p.setBottomTab(null)}>
閉じる
</button>
</span>
</div>
{source === "server"? (
<div className="dev-preview-body">
<div className="dev-preview-bar">
{wcService.devServerRunning? (
<button type="button" className="btn danger sm" onClick={() => void wcService.stopDevServer()}>
サーバー停止
</button>
): (
<button type="button" className="btn primary sm" onClick={() => void startServer()} disabled={busy ||!p.project}>
<DIcon name="play" className="dev-ic sm" /> 開発サーバーを起動（npm run dev）
</button>
)}
{url? (
<>
<span className="dev-preview-url">{url}</span>
<a className="btn sm" href={url} target="_blank" rel="noreferrer">
<Icon name="ext" className="ic sm" /> 新しいタブで開く
</a>
</>
): (
<span className="dev-preview-note">
{wcService.state === "error"
? `ターミナルを利用できないため、開発サーバーも使えません: ${wcService.errorReason}`
: "サーバーが起動すると、ここにURLが表示されます"}
</span>
)}
</div>
{url? (
<div className="dev-preview-framewrap">
<iframe key={reloadKey} className="dev-preview-frame" style={width? { width}: undefined} src={url} title="開発サーバープレビュー" />
</div>
): (
log && <pre className="dev-preview-log">{log}</pre>
)}
</div>
): (
<div className="dev-preview-body">
<div className="dev-preview-bar">
<span className="dev-preview-note">
静的プレビュー: index.html に css/js を埋め込んで表示します（開発サーバー不要）。ファイルを変更すると反映されます。
</span>
</div>
{staticDoc? (
<div className="dev-preview-framewrap">
<iframe
key={`${reloadKey}-${staticDoc.length}`}
className="dev-preview-frame"
style={width? { width}: undefined}
srcDoc={staticDoc}
sandbox="allow-scripts"
title="静的プレビュー"
/>
</div>
): (
<div className="dev-empty-note" style={{ padding: 12}}>
このプロジェクトには index.html がないため、静的プレビューは使えません。
</div>
)}
</div>
)}
</div>
);
}

function ProblemsPane(p: ShellProps) {
const errors = p.markers.filter((m) => m.severity >= 4);
return (
<div className="dev-pane problems">
<div className="dev-pane-head">
<span>
<Icon name="alert" className="ic sm" /> 問題（エディターの診断）
</span>
<span className="dev-pane-btns">
<button type="button" className="btn sm dev-pane-close" onClick={() => p.setBottomTab(null)}>
閉じる
</button>
</span>
</div>
<div className="dev-problems-list">
{errors.length === 0 && <div className="dev-empty-note">現在、開いているファイルに問題は検出されていません（TypeScript/JavaScript の診断が対象です）。</div>}
{errors.map((m, i) => (
<button key={i} type="button" className="dev-problem-row" onClick={() => p.openFile(m.path)}>
<span className={`sev${m.severity >= 8? " err": ""}`}>{m.severity >= 8? "エラー": "警告"}</span>
<span className="loc">
{m.path}:{m.startLineNumber}
</span>
<span className="msg">{m.message}</span>
</button>
))}
</div>
</div>
);
}

/* ---------- シート類 ---------- */

function NewProjectSheet({ onClose, onCreate}: { onClose: () => void; onCreate: (name: string, tpl: string) => void}) {
const [name, setName] = useState("");
const [tpl, setTpl] = useState("static");
return (
<div className="dev-sheet-back" onClick={onClose}>
<div className="dev-sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="新規プロジェクト">
<div className="dev-sheet-head">
<span>新規プロジェクト</span>
<button type="button" className="btn sm" onClick={onClose}>
<Icon name="x" className="ic sm" />
</button>
</div>
<label className="dev-field">
<span>名前</span>
<input value={name} onChange={(e) => setName(e.target.value)} placeholder="プロジェクト名" autoFocus />
</label>
<div className="dev-field">
<span>テンプレート</span>
{TEMPLATES.map((t) => (
<label key={t.id} className={`dev-tpl${tpl === t.id? " on": ""}`}>
<input type="radio" name="tpl" checked={tpl === t.id} onChange={() => setTpl(t.id)} />
<span className="t">{t.name}</span>
<span className="d">{t.desc}</span>
</label>
))}
</div>
<button type="button" className="btn primary" onClick={() => onCreate(name.trim() || "新規プロジェクト", tpl)}>
作成する
</button>
</div>
</div>
);
}

function ModelSheet({ onClose}: { onClose: () => void}) {
const conf = useStoreLocal((s) => s.conf);
const [selProvider, setSelProvider] = useState(conf.provider === "auto"? "gemini": conf.provider);
const providers = allProviders();
const models = modelListOf(selProvider);
const efforts: Array<{ id: Effort; label: string}> = [
{ id: "low", label: "低"},
{ id: "medium", label: "中"},
{ id: "high", label: "高"},
{ id: "super", label: "最大"},
];
return (
<div className="dev-sheet-back" onClick={onClose}>
<div className="dev-sheet wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="モデル選択">
<div className="dev-sheet-head">
<span>AIモデル（本体と共通の設定です）</span>
<button type="button" className="btn sm" onClick={onClose}>
<Icon name="x" className="ic sm" />
</button>
</div>
<button
type="button"
className={`dev-model-auto${conf.provider === "auto"? " on": ""}`}
onClick={() => {
const st = getState();
update({ conf: {...st.conf, provider: "auto"}});
onClose();
}}
>
Eluntra Auto（質問に合わせて自動選択）
</button>
<div className="dev-model-cols">
<div className="dev-model-providers">
{providers.map((pr) => (
<button
key={pr.id}
type="button"
className={selProvider === pr.id? "on": ""}
onClick={() => setSelProvider(pr.id)}
>
{pr.name}
<span className="st">{hasCredentials(pr.id)? "": "（キー未設定）"}</span>
</button>
))}
</div>
<div className="dev-model-models">
{models.length === 0 && <div className="dev-empty-note">モデル一覧がありません。本体で一覧取得してください。</div>}
{models.map((m) => (
<button
key={m}
type="button"
className={conf.provider === selProvider && selectedModel(selProvider) === m? "on": ""}
onClick={() => {
const st = getState();
update({
conf: {...st.conf, provider: selProvider, models: {...st.conf.models, [selProvider]: m}},
});
onClose();
}}
>
{m}
</button>
))}
</div>
</div>
<div className="dev-field">
<span>思考レベル</span>
<div className="dev-efforts">
{efforts.map((e) => (
<button
key={e.id}
type="button"
className={conf.effort === e.id? "on": ""}
onClick={() => {
const st = getState();
update({ conf: {...st.conf, effort: e.id}});
}}
>
{e.label}
</button>
))}
</div>
</div>
</div>
</div>
);
}

import { useStore as useStoreLocal} from "../lib/store";

/* ---------- GitHubシート ---------- */

function GitHubSheet(props: ShellProps & { onClose: () => void; askConfirm: AskConfirm }) {
  const p = props;
  const connected = githubConnected();
  const [viewer, setViewer] = useState<string>("");
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [selRepo, setSelRepo] = useState<string>("");
  const [selBranch, setSelBranch] = useState<string>("");
  const [newRepoName, setNewRepoName] = useState("");
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [commitMsg, setCommitMsg] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [prBase, setPrBase] = useState("main");
  const [repoBranches, setRepoBranches] = useState<GhBranch[]>([]);
  const [newBranchName, setNewBranchName] = useState("");
  const [newBranchBase, setNewBranchBase] = useState("");
  const [switchTo, setSwitchTo] = useState("");
  const [busy, setBusy] = useState("");
  const [info, setInfo] = useState("");
  const [error, setError] = useState("");

  const project = p.project;
  const link = project?.github;
  const changed = project ? ghChangedFiles(project) : [];

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    (async () => {
      try {
        const v = await ghViewer();
        if (alive) setViewer(v.login);
        const rs = await ghListRepos();
        if (alive) setRepos(rs);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [connected]);

  useEffect(() => {
    if (!selRepo) return;
    const [owner, repo] = selRepo.split("/");
    let alive = true;
    (async () => {
      try {
        const bs = await ghListBranches(owner, repo);
        if (!alive) return;
        setBranches(bs);
        const r = repos.find((x) => x.fullName === selRepo);
        setSelBranch(r?.defaultBranch || bs[0] || "main");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selRepo, repos]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError("");
    setInfo("");
    try {
      const msg = await fn();
      setInfo(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy("");
  };

  const openRepo = () =>
    run("open", async () => {
      const [owner, repo] = selRepo.split("/");
      const res = await ghOpenRepo(owner, repo, selBranch);
      const pr = createProject(repo, "empty");
      pr.name = repo;
      pr.files = res.files;
      pr.github = { owner, repo, branch: res.branch, headSha: res.headSha, baseFiles: { ...res.files } };
      pr.changeLog = [
        { at: Date.now(), path: "", kind: "create", source: "github", detail: `${selRepo}@${res.branch} を開きました` },
      ];
      p.commitProjects([pr, ...p.projects]);
      p.setActiveId(pr.id);
      return `${selRepo}（${res.branch}）を開きました。${Object.keys(res.files).length}ファイルを取得${
        res.skipped.length ? `、${res.skipped.length}件はサイズ・形式のため未取得: ${res.skipped.slice(0, 5).join(", ")}${res.skipped.length > 5 ? " ほか" : ""}` : ""
      }`;
    });

  const createRepo = () =>
    run("create", async () => {
      if (!project) throw new Error("先にプロジェクトを選択してください");
      const name = newRepoName.trim();
      if (!name) throw new Error("リポジトリ名を入力してください");
      const r = await ghCreateRepo(name, newRepoPrivate);
      const headSha = await ghHeadSha(r.owner, r.name, r.defaultBranch);
      p.updateProject(project.id, (pr) => ({
        ...pr,
        github: { owner: r.owner, repo: r.name, branch: r.defaultBranch, headSha, baseFiles: {} },
      }));
      return `リポジトリ ${r.fullName} を作成し、このプロジェクトと紐付けました。「コミット＆プッシュ」でファイルを追加できます。`;
    });

  const push = () =>
    run("push", async () => {
      if (!project || !link) throw new Error("プロジェクトがGitHubと紐付いていません");
      const msg = commitMsg.trim() || "Update from Eluntra Developer";
      const sha = await ghPush(project, link, msg);
      p.updateProject(project.id, (pr) => ({
        ...pr,
        github: pr.github ? { ...pr.github, headSha: sha, baseFiles: { ...pr.files } } : pr.github,
        changeLog: [
          { at: Date.now(), path: "", kind: "edit" as const, source: "github" as const, detail: `コミット＆プッシュ: ${msg}` },
          ...(pr.changeLog || []),
        ].slice(0, 100),
      }));
      setCommitMsg("");
      return `プッシュしました（コミット ${sha.slice(0, 7)}）`;
    });

  const pull = () =>
    run("pull", async () => {
      if (!project || !link) throw new Error("プロジェクトがGitHubと紐付いていません");
      if (changed.length > 0) {
        const ok = await props.askConfirm(
          `未プッシュの変更が ${changed.length} 件あります。再取得すると上書きされます。続行しますか？`,
        );
        if (!ok) return "再取得を中止しました";
      }
      const res = await ghOpenRepo(link.owner, link.repo, link.branch);
      p.updateProject(project.id, (pr) => ({
        ...pr,
        files: res.files,
        github: { ...link, headSha: res.headSha, baseFiles: { ...res.files } },
        changeLog: [
          { at: Date.now(), path: "", kind: "edit" as const, source: "github" as const, detail: "GitHubから再取得（Pull）" },
          ...(pr.changeLog || []),
        ].slice(0, 100),
      }));
      p.baselineRef.current = { ...res.files };
      return `再取得しました（${Object.keys(res.files).length}ファイル）`;
    });

  const linkKey = link ? `${link.owner}/${link.repo}` : "";

  useEffect(() => {
    if (!connected || !link) {
      setRepoBranches([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const bs = await ghListBranchesDetailed(link.owner, link.repo);
        if (!alive) return;
        setRepoBranches(bs);
        setNewBranchBase(link.branch);
        setSwitchTo(link.branch);
        setPrBase((cur) => (bs.some((b) => b.name === cur) ? cur : bs.find((b) => b.name !== link.branch)?.name || bs[0]?.name || cur));
      } catch {
        if (alive) setRepoBranches([]);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, linkKey]);

  const switchBranch = () =>
    run("switch", async () => {
      if (!project || !link) throw new Error("プロジェクトがGitHubと紐付いていません");
      const target = switchTo;
      if (!target || target === link.branch) throw new Error("現在のブランチと同じです");
      if (changed.length > 0) {
        const ok = await props.askConfirm(
          `未プッシュの変更が ${changed.length} 件あります。ブランチを切り替えると現在のファイルは「${target}」の内容に置き換わります。続行しますか？`,
        );
        if (!ok) return "ブランチ切替を中止しました";
      }
      const res = await ghOpenRepo(link.owner, link.repo, target);
      p.updateProject(project.id, (pr) => ({
        ...pr,
        files: res.files,
        github: { ...link, branch: target, headSha: res.headSha, baseFiles: { ...res.files } },
        changeLog: [
          { at: Date.now(), path: "", kind: "edit" as const, source: "github" as const, detail: `ブランチを ${target} に切り替え` },
          ...(pr.changeLog || []),
        ].slice(0, 100),
      }));
      p.baselineRef.current = { ...res.files };
      return `ブランチを ${target} に切り替えました（${Object.keys(res.files).length}ファイル）`;
    });

  const createBranch = () =>
    run("branch", async () => {
      if (!project || !link) throw new Error("プロジェクトがGitHubと紐付いていません");
      const name = newBranchName.trim();
      if (!name) throw new Error("新しいブランチ名を入力してください");
      const base = newBranchBase || link.branch;
      await ghCreateBranch(link.owner, link.repo, name, base);
      setNewBranchName("");
      const bs = await ghListBranchesDetailed(link.owner, link.repo);
      setRepoBranches(bs);
      return `ブランチ「${name}」を作成しました（起点: ${base}）。使う場合は「ブランチを切り替え」で選んでください。`;
    });

  const createPR = () =>
    run("pr", async () => {
      if (!link) throw new Error("プロジェクトがGitHubと紐付いていません");
      if (link.branch === prBase) throw new Error("headブランチとbaseブランチが同じです。別のbaseを選ぶか、「ブランチ」欄で新しいブランチを作成して切り替えてください");
      const pr = await ghCreatePR(link.owner, link.repo, prTitle.trim() || "Eluntra Developer からの変更", prBody, link.branch, prBase);
      return `Pull Request #${pr.number} を作成しました: ${pr.url}`;
    });

  return (
    <div className="dev-sheet-back" onClick={props.onClose}>
      <div className="dev-sheet wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="GitHub連携">
        <div className="dev-sheet-head">
          <span>
            <img src="./logos/conn-github.svg" alt="" width={18} height={18} /> GitHub連携
          </span>
          <button type="button" className="btn sm" onClick={props.onClose}>
            <Icon name="x" className="ic sm" />
          </button>
        </div>

        {!connected && (
          <div className="dev-gh-note">
            GitHubコネクタが未接続です。本体（Eluntra）の「設定 → コネクタ」でGitHubを接続すると、ここでリポジトリの読み込み・作成・プッシュ・Pull
            Requestが使えます。
            <a className="btn primary sm" href="./index.html">
              本体を開く
            </a>
          </div>
        )}
        {connected && (
          <>
            <div className="dev-gh-viewer">{viewer ? `@${viewer} として接続中` : "接続を確認中…"}</div>
            {error && <div className="dev-gh-error">{error}</div>}
            {info && <div className="dev-gh-info">{info}</div>}

            <div className="dev-field">
              <span>リポジトリを開く（新しいローカルプロジェクトとして取得）</span>
              <div className="dev-gh-row">
                <select value={selRepo} onChange={(e) => setSelRepo(e.target.value)} aria-label="リポジトリ">
                  <option value="">選択してください</option>
                  {repos.map((r) => (
                    <option key={r.fullName} value={r.fullName}>
                      {r.fullName}
                      {r.private ? "（private）" : ""}
                    </option>
                  ))}
                </select>
                <select value={selBranch} onChange={(e) => setSelBranch(e.target.value)} aria-label="ブランチ">
                  {branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn primary sm" disabled={!selRepo || !!busy} onClick={() => void openRepo()}>
                  {busy === "open" ? "取得中…" : "開く"}
                </button>
              </div>
            </div>

            <div className="dev-field">
              <span>新規リポジトリ作成（現在のプロジェクトと紐付け）</span>
              <div className="dev-gh-row">
                <input value={newRepoName} onChange={(e) => setNewRepoName(e.target.value)} placeholder="リポジトリ名" />
                <label className="dev-gh-priv">
                  <input type="checkbox" checked={newRepoPrivate} onChange={(e) => setNewRepoPrivate(e.target.checked)} /> Private
                </label>
                <button type="button" className="btn sm" disabled={!!busy || !project} onClick={() => void createRepo()}>
                  {busy === "create" ? "作成中…" : "作成"}
                </button>
              </div>
            </div>

            {project && link && (
              <>
                <div className="dev-field">
                  <span>
                    紐付け中: {link.owner}/{link.repo} @ {link.branch}（HEAD {link.headSha.slice(0, 7)}）
                  </span>
                  <div className="dev-gh-changed">
                    {changed.length === 0 && <span>変更はありません</span>}
                    {changed.slice(0, 30).map((c) => (
                      <div key={c.path} className="dev-gh-changed-row">
                        <span className={`k ${c.kind}`}>{c.kind === "added" ? "追加" : c.kind === "deleted" ? "削除" : "変更"}</span>
                        <span>{c.path}</span>
                      </div>
                    ))}
                    {changed.length > 30 && <span>ほか {changed.length - 30} 件</span>}
                  </div>
                  <div className="dev-gh-row">
                    <input value={commitMsg} onChange={(e) => setCommitMsg(e.target.value)} placeholder="コミットメッセージ" />
                    <button type="button" className="btn primary sm" disabled={!!busy || changed.length === 0} onClick={() => void push()}>
                      {busy === "push" ? "プッシュ中…" : "コミット＆プッシュ"}
                    </button>
                    <button type="button" className="btn sm" disabled={!!busy} onClick={() => void pull()}>
                      {busy === "pull" ? "取得中…" : "再取得（Pull）"}
                    </button>
                  </div>
                </div>
                <div className="dev-field">
                  <span>
                    <DIcon name="branch" className="dev-ic sm" /> ブランチ（現在: {link.branch}）
                  </span>
                  <div className="dev-gh-row">
                    <select value={switchTo} onChange={(e) => setSwitchTo(e.target.value)} aria-label="切替先ブランチ">
                      {repoBranches.map((b) => (
                        <option key={b.name} value={b.name}>
                          {b.name}
                          {b.name === link.branch ? "（現在）" : ""}
                        </option>
                      ))}
                      {repoBranches.length === 0 && <option value={link.branch}>{link.branch}</option>}
                    </select>
                    <button type="button" className="btn sm" disabled={!!busy || !switchTo || switchTo === link.branch} onClick={() => void switchBranch()}>
                      {busy === "switch" ? "切替中…" : "ブランチを切り替え"}
                    </button>
                  </div>
                  <div className="dev-gh-row">
                    <input value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} placeholder="新しいブランチ名（例: feature/login）" aria-label="新しいブランチ名" />
                    <select value={newBranchBase} onChange={(e) => setNewBranchBase(e.target.value)} aria-label="起点ブランチ">
                      {repoBranches.map((b) => (
                        <option key={b.name} value={b.name}>
                          起点: {b.name}
                        </option>
                      ))}
                      {repoBranches.length === 0 && <option value={link.branch}>起点: {link.branch}</option>}
                    </select>
                    <button type="button" className="btn sm" disabled={!!busy || !newBranchName.trim()} onClick={() => void createBranch()}>
                      {busy === "branch" ? "作成中…" : "ブランチを作成"}
                    </button>
                  </div>
                  <span className="dev-gh-note-inline">プッシュ先は現在のブランチ（{link.branch}）です。切替時はそのブランチの内容でファイルが置き換わります。</span>
                </div>
                <div className="dev-field">
                  <span>Pull Request作成（head: {link.branch}）</span>
                  <div className="dev-gh-row">
                    {repoBranches.length > 0 ? (
                      <select value={prBase} onChange={(e) => setPrBase(e.target.value)} aria-label="baseブランチ">
                        {repoBranches.map((b) => (
                          <option key={b.name} value={b.name}>
                            base: {b.name}
                          </option>
                        ))}
                        {!repoBranches.some((b) => b.name === prBase) && <option value={prBase}>base: {prBase}</option>}
                      </select>
                    ) : (
                      <input value={prBase} onChange={(e) => setPrBase(e.target.value)} placeholder="baseブランチ" aria-label="baseブランチ" />
                    )}
                    <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="タイトル" aria-label="PRタイトル" />
                  </div>
                  <textarea value={prBody} onChange={(e) => setPrBody(e.target.value)} placeholder="本文" rows={2} aria-label="PR本文" />
                  <button type="button" className="btn sm" disabled={!!busy} onClick={() => void createPR()}>
                    {busy === "pr" ? "作成中…" : "Pull Requestを作成"}
                  </button>
                </div>
              </>
            )}
            {project && !link && <div className="dev-gh-note">現在のプロジェクトはGitHubと紐付いていません。「開く」か「作成」で紐付けできます。</div>}
          </>
        )}
      </div>
    </div>
  );
}
