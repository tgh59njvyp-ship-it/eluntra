/* Eluntra Developer: AIソフトウェア開発環境（v7.2.4）
   構成: 起動時はダッシュボード（プロジェクト一覧）。プロジェクトを開くと
   ワークスペース（左=プロジェクト/ファイルツリー、中央=Monacoエディター、
   右=AI開発チャット、下部=ターミナル/プレビュー/問題。モバイルは下部タブ切替）。
   ファイルは eluntra_dev_projects（localStorage）に実保存され、AIチャットは
   プロジェクトごとに eluntra_dev_chats へ分けて保存する。
   ターミナルと開発サーバーは WebContainer（ブラウザ内Node.js）で実際に動く。
   このファイルは状態管理を担い、描画は panels.tsx に委ねる。 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getState, useStore } from "../lib/store";
import type { EditorApi, MarkerInfo } from "./Editor";
import {
  UndoManager, appendChangeLog, listPaths, loadProjects, saveProjects, writeFile,
  type DevProject,
} from "./fs";
import {
  getProjectChat, loadChats, saveChats, withProjectChat, withoutProjectChat,
  type DevChats, type ProjectChat,
} from "./chatstore";
import { ShellMain, type ShellProps } from "./panels";
import { wcService } from "./webcontainer";

export type { ShellProps };

export type BottomTab = "terminal" | "preview" | "problems" | "database";
export type MobileTab = "files" | "editor" | "ai" | "preview" | "terminal";
export type DevView = "dashboard" | "workspace";

const ACTIVE_PROJECT_LS = "eluntra_dev_active_project";

export function DeveloperApp() {
  const theme = useStore((s) => s.theme);
  const conf = useStore((s) => s.conf);

  const [projects, setProjects] = useState<DevProject[]>(() => loadProjects());
  const [activeId, setActiveId] = useState<string>(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(ACTIVE_PROJECT_LS);
    } catch {
      saved = null;
    }
    const list = loadProjects();
    return saved && list.some((p) => p.id === saved) ? saved : list[0]?.id || "";
  });
  const project = projects.find((p) => p.id === activeId) || null;

  /* ダッシュボード／ワークスペースの切り替え（起動時はダッシュボード） */
  const [view, setView] = useState<DevView>("dashboard");
  const [lastActiveId] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTIVE_PROJECT_LS) || "";
    } catch {
      return "";
    }
  });

  /* プロジェクト別チャット（eluntra_dev_chats へ保存） */
  const [chats, setChats] = useState<DevChats>(() => loadChats());
  const chatSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (chatSaveTimerRef.current) window.clearTimeout(chatSaveTimerRef.current);
    chatSaveTimerRef.current = window.setTimeout(() => saveChats(chats), 400);
    return () => {
      if (chatSaveTimerRef.current) window.clearTimeout(chatSaveTimerRef.current);
    };
  }, [chats]);
  const onChatChange = useCallback((projectId: string, chat: ProjectChat) => {
    setChats((prev) => withProjectChat(prev, projectId, chat, false));
  }, []);

  /* AI実行中はプロジェクト切替とダッシュボード復帰を無効化する */
  const [agentRunning, setAgentRunningState] = useState(false);
  const agentRunningRef = useRef(false);
  const setAgentRunning = useCallback((b: boolean) => {
    agentRunningRef.current = b;
    setAgentRunningState(b);
  }, []);

  const enterProject = useCallback((id: string) => {
    if (agentRunningRef.current) return;
    setActiveId(id);
    setView("workspace");
  }, []);

  const goDashboard = useCallback(() => {
    if (agentRunningRef.current) return;
    setView("dashboard");
  }, []);

  const deleteProject = useCallback(
    (id: string) => {
      if (agentRunningRef.current) return;
      setProjects((prev) => {
        const next = prev.filter((x) => x.id !== id);
        saveProjects(next);
        if (id === activeId) setActiveId(next[0]?.id || "");
        return next;
      });
      setChats((prev) => withoutProjectChat(prev, id));
    },
    [activeId],
  );

  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>("files");
  const [showDiff, setShowDiff] = useState(false);
  const [diffPair, setDiffPair] = useState<{ title: string; before: string; after: string } | null>(null);
  const [markers, setMarkers] = useState<MarkerInfo[]>([]);

  const undoMgrRef = useRef<UndoManager | null>(null);
  if (!undoMgrRef.current) undoMgrRef.current = new UndoManager();
  const applyingRef = useRef(false);
  const baselineRef = useRef<Record<string, string>>({});
  const editorApiRef = useRef<EditorApi | null>(null);
  const sessionFilesRef = useRef(new Set<string>());
  const syncTimerRef = useRef<number | null>(null);
  const lastSyncedRef = useRef<Record<string, string>>({});

  const commitProjects = useCallback((next: DevProject[]) => {
    setProjects(next);
    saveProjects(next);
  }, []);

  const updateProject = useCallback((id: string, fn: (p: DevProject) => DevProject) => {
    setProjects((prev) => {
      const next = prev.map((p) => (p.id === id ? fn(p) : p));
      saveProjects(next);
      return next;
    });
  }, []);

  const applyFileChange = useCallback(
    (
      files: Record<string, string>,
      log?: { path: string; kind: "create" | "edit" | "delete" | "rename"; source: "user" | "ai" | "github"; detail?: string },
    ) => {
      if (!project) return;
      updateProject(project.id, (p) => {
        let next: DevProject = { ...p, files, updatedAt: Date.now() };
        if (log) next = appendChangeLog(next, { at: Date.now(), ...log });
        return next;
      });
    },
    [project, updateProject],
  );

  // アクティブプロジェクト切替時の初期化
  useEffect(() => {
    baselineRef.current = project ? { ...project.files } : {};
    lastSyncedRef.current = {};
    const first = project ? listPaths(project.files)[0] || null : null;
    setOpenTabs(first ? [first] : []);
    setActivePath(first);
    setShowDiff(false);
    setDiffPair(null);
    try {
      if (project) localStorage.setItem(ACTIVE_PROJECT_LS, project.id);
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // WebContainer へのファイル同期（起動済みのときだけ）
  const files = project?.files || {};
  useEffect(() => {
    if (!project || wcService.state !== "ready") return;
    if (syncTimerRef.current) window.clearTimeout(syncTimerRef.current);
    const snapshot = project.files;
    syncTimerRef.current = window.setTimeout(() => {
      const prev = lastSyncedRef.current;
      const all = new Set([...Object.keys(prev), ...Object.keys(snapshot)]);
      all.forEach((path) => {
        if (prev[path] !== snapshot[path]) void wcService.syncFile(path, snapshot[path] ?? null);
      });
      lastSyncedRef.current = { ...snapshot };
    }, 700);
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = useCallback((path: string) => {
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
    setActivePath(path);
    setMobileTab("editor");
  }, []);

  const closeTab = useCallback(
    (path: string) => {
      setOpenTabs((tabs) => {
        const next = tabs.filter((t) => t !== path);
        if (activePath === path) setActivePath(next[next.length - 1] || null);
        return next;
      });
    },
    [activePath],
  );

  /* エディタからの編集（自動保存：停止後600msで確定し、Undo履歴を積む） */
  const editTimerRef = useRef<number | null>(null);
  const pendingEditRef = useRef<{ path: string; before: string; value: string } | null>(null);
  const flushEdit = useCallback(() => {
    const pending = pendingEditRef.current;
    if (!pending || !project) return;
    pendingEditRef.current = null;
    if (pending.before === pending.value) return;
    undoMgrRef.current?.push(pending.path, pending.before, pending.value);
    applyFileChange(writeFile(project.files, pending.path, pending.value), undefined);
  }, [project, applyFileChange]);

  const onEditorChange = useCallback(
    (value: string) => {
      if (!activePath || applyingRef.current || !project) return;
      if (!pendingEditRef.current || pendingEditRef.current.path !== activePath) {
        pendingEditRef.current = { path: activePath, before: project.files[activePath] ?? "", value };
      } else {
        pendingEditRef.current.value = value;
      }
      if (editTimerRef.current) window.clearTimeout(editTimerRef.current);
      editTimerRef.current = window.setTimeout(flushEdit, 600);
    },
    [activePath, project, flushEdit],
  );

  const doUndo = useCallback(() => {
    if (!activePath || !project) return;
    flushEdit();
    const prev = undoMgrRef.current?.undo(activePath, project.files[activePath] ?? "");
    if (prev === null || prev === undefined) return;
    applyingRef.current = true;
    applyFileChange(writeFile(project.files, activePath, prev), undefined);
    window.setTimeout(() => {
      applyingRef.current = false;
    }, 80);
  }, [activePath, project, applyFileChange, flushEdit]);

  const doRedo = useCallback(() => {
    if (!activePath || !project) return;
    const next = undoMgrRef.current?.redo(activePath, project.files[activePath] ?? "");
    if (next === null || next === undefined) return;
    applyingRef.current = true;
    applyFileChange(writeFile(project.files, activePath, next), undefined);
    window.setTimeout(() => {
      applyingRef.current = false;
    }, 80);
  }, [activePath, project, applyFileChange]);

  const shellProps: ShellProps = {
    theme,
    conf,
    projects,
    project,
    activeId,
    setActiveId,
    view,
    setView,
    enterProject,
    goDashboard,
    lastActiveId,
    agentRunning,
    setAgentRunning,
    chats,
    chatData: getProjectChat(chats, activeId),
    onChatChange,
    deleteProject,
    commitProjects,
    updateProject,
    applyFileChange,
    openTabs,
    activePath,
    openFile,
    closeTab,
    setActivePath,
    activeContent: activePath ? files[activePath] ?? "" : "",
    onEditorChange,
    flushEdit,
    doUndo,
    doRedo,
    bottomTab,
    setBottomTab,
    mobileTab,
    setMobileTab,
    showDiff,
    setShowDiff,
    diffPair,
    setDiffPair,
    markers,
    setMarkers,
    editorApiRef,
    baselineRef,
    sessionFilesRef,
    getConf: () => getState().conf,
  };

  return <ShellMain {...shellProps} />;
}
