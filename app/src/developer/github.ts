/* Eluntra Developer: GitHub連携
   本体のGitHubコネクタ（eluntra_connectors）のトークンを使い、api.github.com へ直接アクセスする。
   プッシュは Git Data API（blob→tree→commit→ref更新）で全ファイルをコミットする。 */

import { connectorToken } from "../lib/connectors/registry";
import type { DevProject, GhLink } from "./fs";
import { normalizePath } from "./fs";

const API = "https://api.github.com";

export function githubToken(): string {
  return connectorToken("github");
}

export function githubConnected(): boolean {
  return !!githubToken();
}

interface GhError extends Error {
  status?: number;
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = githubToken();
  if (!token) throw new Error("GitHubコネクタが未接続です。本体の「設定 → コネクタ」でGitHubを接続してください。");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `GitHub API エラー（${res.status}）`;
    try {
      const j = JSON.parse(text) as { message?: string };
      if (j.message) msg += `: ${j.message}`;
    } catch {
      /* ignore */
    }
    if (res.status === 401) msg += "。対処：本体の設定でGitHubコネクタの接続を確認してください。";
    if (res.status === 403) msg += "。対処：トークンの権限（repo への書き込み）を確認してください。";
    if (res.status === 404) msg += "。対処：リポジトリ名とアクセス権を確認してください。";
    const err = new Error(msg) as GhError;
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface GhViewer {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export async function ghViewer(): Promise<GhViewer> {
  const j = await gh<{ login: string; name?: string; avatar_url?: string }>("/user");
  return { login: j.login, name: j.name, avatarUrl: j.avatar_url };
}

export interface GhRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  description?: string;
  updatedAt?: string;
}

export async function ghListRepos(): Promise<GhRepo[]> {
  const arr = await gh<Array<{
    full_name: string;
    owner: { login: string };
    name: string;
    private: boolean;
    default_branch: string;
    description?: string;
    updated_at?: string;
  }>>("/user/repos?per_page=100&sort=updated");
  return arr.map((r) => ({
    fullName: r.full_name,
    owner: r.owner.login,
    name: r.name,
    private: r.private,
    defaultBranch: r.default_branch,
    description: r.description,
    updatedAt: r.updated_at,
  }));
}

export async function ghListBranches(owner: string, repo: string): Promise<string[]> {
  const arr = await gh<Array<{ name: string }>>(`/repos/${owner}/${repo}/branches?per_page=100`);
  return arr.map((b) => b.name);
}

export interface GhBranch {
  name: string;
  sha: string;
  protected: boolean;
}

/** ブランチ一覧（名前・先端SHA・保護フラグつき） */
export async function ghListBranchesDetailed(owner: string, repo: string): Promise<GhBranch[]> {
  const arr = await gh<Array<{ name: string; commit: { sha: string }; protected: boolean }>>(
    `/repos/${owner}/${repo}/branches?per_page=100`,
  );
  return arr.map((b) => ({ name: b.name, sha: b.commit.sha, protected: !!b.protected }));
}

/** git/refs 作成リクエストのボディ（純粋関数。単体テスト対象） */
export function buildCreateRefBody(branch: string, sha: string): { ref: string; sha: string } {
  const name = (branch || "").trim();
  if (!name) throw new Error("ブランチ名が空です");
  if (/[\s~^:?*[\\]/.test(name) || name.startsWith("/") || name.endsWith("/") || name.includes("..")) {
    throw new Error(`ブランチ名に使えない文字が含まれています: ${branch}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`SHAの形式が不正です: ${sha}`);
  return { ref: `refs/heads/${name}`, sha };
}

/** 既存ブランチ（base）の先端から新しいブランチを作成する */
export async function ghCreateBranch(owner: string, repo: string, newBranch: string, baseBranch: string): Promise<GhBranch> {
  const sha = await ghHeadSha(owner, repo, baseBranch);
  const body = buildCreateRefBody(newBranch, sha);
  try {
    await gh(`/repos/${owner}/${repo}/git/refs`, { method: "POST", body: JSON.stringify(body) });
  } catch (e) {
    const err = e as GhError;
    if (err.status === 422) {
      throw new Error(`ブランチを作成できませんでした（422）。「${newBranch}」がすでに存在するか、名前が不正です。`);
    }
    throw e;
  }
  return { name: newBranch.trim(), sha, protected: false };
}

export async function ghCreateRepo(name: string, priv: boolean): Promise<GhRepo> {
  const j = await gh<{
    full_name: string;
    owner: { login: string };
    name: string;
    private: boolean;
    default_branch: string;
  }>("/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: priv, auto_init: true }),
  });
  return { fullName: j.full_name, owner: j.owner.login, name: j.name, private: j.private, defaultBranch: j.default_branch };
}

/* ---------- base64（UTF-8対応） ---------- */

export function utf8ToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ---------- リポジトリを開く ---------- */

const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svgz", "pdf", "zip", "gz", "tar", "xz", "7z",
  "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "mov", "avi", "webm", "wasm", "exe", "dll",
  "so", "dylib", "class", "jar", "lockb", "db", "sqlite",
]);

const MAX_FILES = 400;
const MAX_FILE_BYTES = 256 * 1024;

export interface OpenRepoResult {
  files: Record<string, string>;
  headSha: string;
  branch: string;
  skipped: string[];
}

interface TreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

export async function ghOpenRepo(owner: string, repo: string, branch: string): Promise<OpenRepoResult> {
  const ref = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object.sha;
  const tree = await gh<{ tree: TreeItem[]; truncated?: boolean }>(
    `/repos/${owner}/${repo}/git/trees/${headSha}?recursive=1`,
  );
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  const blobs = tree.tree.filter((t) => t.type === "blob");
  for (const item of blobs) {
    const path = normalizePath(item.path);
    const ext = path.split(".").pop()?.toLowerCase() || "";
    if (BINARY_EXT.has(ext) || (item.size ?? 0) > MAX_FILE_BYTES || Object.keys(files).length >= MAX_FILES || path === "package-lock.json") {
      skipped.push(path);
      continue;
    }
    const blob = await gh<{ content: string; encoding: string }>(`/repos/${owner}/${repo}/git/blobs/${item.sha}`);
    try {
      files[path] = b64ToUtf8(blob.content);
    } catch {
      skipped.push(path);
    }
  }
  if (tree.truncated) skipped.push("（ツリーが大きいため一部のみ取得）");
  return { files, headSha, branch, skipped };
}

/* ---------- コミット＆プッシュ（Git Data API） ---------- */

export async function ghPush(project: DevProject, link: GhLink, message: string): Promise<string> {
  const { owner, repo, branch } = link;
  // 現在のHEADを取り直す（他で進んでいたら、その上に積む）
  const ref = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object.sha;
  const headCommit = await gh<{ tree: { sha: string } }>(`/repos/${owner}/${repo}/git/commits/${headSha}`);

  // blob を作る
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const [path, content] of Object.entries(project.files)) {
    const blob = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: utf8ToB64(content), encoding: "base64" }),
    });
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  // HEAD側にあってローカルに無いファイルは削除として tree に載せる（sha: null）
  for (const path of Object.keys(link.baseFiles)) {
    if (!(path in project.files)) treeItems.push({ path, mode: "100644", type: "blob", sha: null as unknown as string });
  }

  const tree = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: treeItems }),
  });
  const commit = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }),
  });
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });
  return commit.sha;
}

/** HEAD（読み込み時）と比較した変更ファイル一覧 */
export function ghChangedFiles(project: DevProject): Array<{ path: string; kind: "added" | "modified" | "deleted" }> {
  const link = project.github;
  if (!link) return Object.keys(project.files).map((path) => ({ path, kind: "added" as const }));
  const out: Array<{ path: string; kind: "added" | "modified" | "deleted" }> = [];
  for (const [path, content] of Object.entries(project.files)) {
    if (!(path in link.baseFiles)) out.push({ path, kind: "added" });
    else if (link.baseFiles[path] !== content) out.push({ path, kind: "modified" });
  }
  for (const path of Object.keys(link.baseFiles)) {
    if (!(path in project.files)) out.push({ path, kind: "deleted" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function ghCreatePR(
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
): Promise<{ number: number; url: string }> {
  const j = await gh<{ number: number; html_url: string }>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });
  return { number: j.number, url: j.html_url };
}

/** ブランチのHEADコミットSHAを取得する */
export async function ghHeadSha(owner: string, repo: string, branch: string): Promise<string> {
  const ref = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  return ref.object.sha;
}
