import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type ContextRef, type RepositoryState } from "./schema.js";
import { runCommand } from "./process.js";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(cwd: string, args: string[], allowFailure = false) {
  return runCommand("git", args, { cwd, allowFailure });
}

export function findRepositoryRoot(cwd = process.cwd()): string {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], true);
  if (result.exitCode !== 0) {
    throw new Error(`Not inside a Git repository: ${cwd}`);
  }
  return result.stdout.trim();
}

function parseChangedFiles(status: string): string[] {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((path) => path.includes(" -> ") ? path.split(" -> ").at(-1)! : path)
    .filter(Boolean)
    .sort();
}

export function hashRepositoryFile(root: string, path: string): string | undefined {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const repoRelative = relative(root, absolute);
  if (repoRelative.startsWith("..") || isAbsolute(repoRelative)) return undefined;
  try {
    if (!statSync(absolute).isFile()) return undefined;
    return sha256(readFileSync(absolute));
  } catch {
    return undefined;
  }
}

export function collectRepositoryState(
  cwd = process.cwd(),
  refs: ContextRef[] = []
): RepositoryState {
  const root = findRepositoryRoot(cwd);
  const branchResult = git(root, ["branch", "--show-current"], true);
  const headResult = git(root, ["rev-parse", "HEAD"], true);
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout;
  const changedFiles = parseChangedFiles(status);
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : "UNBORN";
  const diffArgs = head === "UNBORN"
    ? ["diff", "--stat", "--no-index", "/dev/null", "."]
    : ["diff", "--stat", "HEAD"];
  const diffResult = git(root, diffArgs, true);
  const paths = new Set([...changedFiles, ...refs.map((ref) => ref.path)]);
  const fileHashes: Record<string, string> = {};
  for (const path of paths) {
    const hash = hashRepositoryFile(root, path);
    if (hash) fileHashes[path] = hash;
  }

  return {
    root,
    branch: branchResult.stdout.trim() || "DETACHED",
    head,
    dirty: status.length > 0,
    statusHash: sha256(status),
    changedFiles,
    diffStat: diffResult.stdout.trim(),
    fileHashes
  };
}

export interface FreshnessResult {
  stale: boolean;
  reasons: string[];
  current: RepositoryState;
}

export function verifyRepositoryState(
  recorded: RepositoryState,
  cwd = recorded.root
): FreshnessResult {
  const refs = Object.keys(recorded.fileHashes).map((path) => ({
    path,
    symbols: [],
    reason: "freshness"
  }));
  const current = collectRepositoryState(cwd, refs);
  const reasons: string[] = [];
  const recordedUnborn = recorded.head === "UNBORN";

  if (recordedUnborn) {
    // Unborn repositories churn through unrelated untracked files; only the
    // recorded file hashes are reliable freshness signals until the first commit.
    if (current.branch !== recorded.branch) reasons.push("Git branch changed");
    for (const [path, hash] of Object.entries(recorded.fileHashes)) {
      if (current.fileHashes[path] !== hash) reasons.push(`File changed: ${path}`);
    }
  } else {
    if (current.head !== recorded.head) reasons.push("Git HEAD changed");
    if (current.branch !== recorded.branch) reasons.push("Git branch changed");
    if (current.statusHash !== recorded.statusHash) reasons.push("Working tree changed");
    for (const [path, hash] of Object.entries(recorded.fileHashes)) {
      if (current.fileHashes[path] !== hash) reasons.push(`File changed: ${path}`);
    }
  }
  return { stale: reasons.length > 0, reasons: [...new Set(reasons)], current };
}
