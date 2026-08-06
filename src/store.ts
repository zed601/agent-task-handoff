import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import {
  type Checkpoint,
  type HandoffConfig,
  checkpointSchema,
  configSchema
} from "./schema.js";
import { assertNoSecrets } from "./security.js";

export const HANDOFF_DIRECTORY = ".handoff";

export interface LaunchReceipt {
  version: 1;
  taskId: string;
  revision: number;
  target: string;
  sessionId: string;
  sessionName?: string;
  repositoryRoot: string;
  promptPath: string;
  createdAt: string;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

export function safeId(value: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!id || id === "." || id === "..") throw new Error("Invalid task identifier");
  return id;
}

export function handoffPath(repositoryRoot: string): string {
  return join(repositoryRoot, HANDOFF_DIRECTORY);
}

export function initializeHandoff(repositoryRoot: string): HandoffConfig {
  const root = handoffPath(repositoryRoot);
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, "workflows"), { recursive: true });
  mkdirSync(join(root, "exports"), { recursive: true });
  mkdirSync(join(root, "launches"), { recursive: true });
  const config: HandoffConfig = {
    version: 1,
    defaultAgent: "codex",
    defaultExec: false,
    secretScan: true,
    maxSessionMessages: 80
  };
  const configPath = join(root, "config.yaml");
  if (!existsSync(configPath)) atomicWrite(configPath, YAML.stringify(config));

  const gitignorePath = join(repositoryRoot, ".gitignore");
  const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  if (!lines.includes(`${HANDOFF_DIRECTORY}/`)) {
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignorePath, `${existing}${prefix}${HANDOFF_DIRECTORY}/\n`, "utf8");
  }
  return loadConfig(repositoryRoot);
}

export function isInitialized(repositoryRoot: string): boolean {
  return existsSync(join(handoffPath(repositoryRoot), "config.yaml"));
}

/** Create `.handoff/` on first use so callers do not need an explicit `init`. */
export function ensureInitialized(repositoryRoot: string): {
  config: HandoffConfig;
  created: boolean;
} {
  if (isInitialized(repositoryRoot)) {
    return { config: loadConfig(repositoryRoot), created: false };
  }
  return { config: initializeHandoff(repositoryRoot), created: true };
}

function launchPointerPath(
  repositoryRoot: string,
  taskId?: string,
  target?: string
): string {
  if (!taskId) return join(handoffPath(repositoryRoot), "launches", "latest.json");
  if (!target) return join(handoffPath(repositoryRoot), "launches", safeId(taskId), "latest.json");
  return join(
    handoffPath(repositoryRoot),
    "launches",
    safeId(taskId),
    safeId(target),
    "latest.json"
  );
}

export function saveLaunchReceipt(
  repositoryRoot: string,
  receipt: LaunchReceipt
): string {
  assertNoSecrets(receipt);
  const directory = join(
    handoffPath(repositoryRoot),
    "launches",
    safeId(receipt.taskId),
    safeId(receipt.target)
  );
  const filename = `${receipt.createdAt.replace(/[^0-9]/g, "")}-${safeId(receipt.sessionId)}.json`;
  const path = join(directory, filename);
  atomicWrite(path, `${JSON.stringify(receipt, null, 2)}\n`);
  const pointer = `${JSON.stringify({ path }, null, 2)}\n`;
  atomicWrite(launchPointerPath(repositoryRoot, receipt.taskId, receipt.target), pointer);
  atomicWrite(launchPointerPath(repositoryRoot, receipt.taskId), pointer);
  atomicWrite(launchPointerPath(repositoryRoot), pointer);
  return path;
}

export function loadLaunchReceipt(
  repositoryRoot: string,
  taskId?: string,
  target?: string
): LaunchReceipt {
  const pointerPath = launchPointerPath(repositoryRoot, taskId, target);
  if (!existsSync(pointerPath)) {
    throw new Error("No launched target session found. Run `handoff go --to claude` or `handoff go --to codex` with launch enabled first.");
  }
  const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { path?: unknown };
  if (typeof pointer.path !== "string" || !existsSync(pointer.path)) {
    throw new Error(`Invalid launch receipt pointer: ${pointerPath}`);
  }
  const receipt = JSON.parse(readFileSync(pointer.path, "utf8")) as Partial<LaunchReceipt>;
  if (
    receipt.version !== 1 ||
    typeof receipt.taskId !== "string" ||
    typeof receipt.revision !== "number" ||
    typeof receipt.target !== "string" ||
    typeof receipt.sessionId !== "string" ||
    typeof receipt.repositoryRoot !== "string" ||
    typeof receipt.promptPath !== "string" ||
    typeof receipt.createdAt !== "string"
  ) {
    throw new Error(`Invalid launch receipt: ${pointer.path}`);
  }
  return receipt as LaunchReceipt;
}

export function loadConfig(repositoryRoot: string): HandoffConfig {
  const path = join(handoffPath(repositoryRoot), "config.yaml");
  if (!existsSync(path)) {
    throw new Error("TaskHandoff is not initialized. Run `handoff init` first.");
  }
  return configSchema.parse(YAML.parse(readFileSync(path, "utf8")));
}

function taskDirectory(repositoryRoot: string, taskId: string): string {
  return join(handoffPath(repositoryRoot), "tasks", safeId(taskId));
}

export function nextRevision(repositoryRoot: string, taskId: string): number {
  const revisions = join(taskDirectory(repositoryRoot, taskId), "revisions");
  if (!existsSync(revisions)) return 1;
  const values = readdirSync(revisions)
    .map((file) => Number.parseInt(file.replace(/\.json$/, ""), 10))
    .filter(Number.isFinite);
  return values.length === 0 ? 1 : Math.max(...values) + 1;
}

export function saveCheckpoint(repositoryRoot: string, value: Checkpoint): string {
  const checkpoint = checkpointSchema.parse(value);
  assertNoSecrets(checkpoint);
  const revisions = join(taskDirectory(repositoryRoot, checkpoint.taskId), "revisions");
  const filename = `${String(checkpoint.revision).padStart(4, "0")}.json`;
  const revisionPath = join(revisions, filename);
  if (existsSync(revisionPath)) {
    throw new Error(`Checkpoint revision already exists: ${revisionPath}`);
  }
  const content = `${JSON.stringify(checkpoint, null, 2)}\n`;
  atomicWrite(revisionPath, content);
  atomicWrite(
    join(taskDirectory(repositoryRoot, checkpoint.taskId), "latest.json"),
    `${JSON.stringify({ id: checkpoint.id, revision: checkpoint.revision, path: `revisions/${filename}` }, null, 2)}\n`
  );
  return revisionPath;
}

function listTaskDirectories(repositoryRoot: string): string[] {
  const tasks = join(handoffPath(repositoryRoot), "tasks");
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function resolveTaskId(repositoryRoot: string, taskId?: string): string {
  if (taskId) return safeId(taskId);
  const candidates = listTaskDirectories(repositoryRoot)
    .map((id) => {
      const latestPath = join(taskDirectory(repositoryRoot, id), "latest.json");
      if (!existsSync(latestPath)) return undefined;
      return { id, mtime: readFileSync(latestPath, "utf8") };
    })
    .filter((value): value is { id: string; mtime: string } => Boolean(value));
  if (candidates.length === 0) throw new Error("No checkpoints found");
  return candidates
    .map((candidate) => ({
      ...candidate,
      createdAt: loadCheckpoint(repositoryRoot, candidate.id).createdAt
    }))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]!.id;
}

export function loadCheckpoint(
  repositoryRoot: string,
  taskId?: string,
  revision?: number
): Checkpoint {
  const id = resolveTaskId(repositoryRoot, taskId);
  let path: string;
  if (revision) {
    path = join(taskDirectory(repositoryRoot, id), "revisions", `${String(revision).padStart(4, "0")}.json`);
  } else {
    const latest = JSON.parse(
      readFileSync(join(taskDirectory(repositoryRoot, id), "latest.json"), "utf8")
    ) as { path: string };
    path = resolve(taskDirectory(repositoryRoot, id), latest.path);
  }
  return checkpointSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function exportCheckpoint(
  repositoryRoot: string,
  checkpoint: Checkpoint,
  output?: string,
  format: "json" | "markdown" = "json",
  content?: string
): string {
  assertNoSecrets(checkpoint);
  if (content) assertNoSecrets(content);
  const extension = format === "markdown" ? "md" : "json";
  const destination = output
    ? resolve(output)
    : join(handoffPath(repositoryRoot), "exports", `${checkpoint.taskId}-r${checkpoint.revision}.handoff.${extension}`);
  const serialized = format === "markdown"
    ? content ?? ""
    : JSON.stringify(checkpoint, null, 2);
  atomicWrite(destination, `${serialized.trimEnd()}\n`);
  return destination;
}

export function saveRenderedHandoff(
  repositoryRoot: string,
  checkpoint: Checkpoint,
  target: string,
  content: string,
  output?: string
): string {
  assertNoSecrets(content);
  const destination = output
    ? resolve(output)
    : join(
      handoffPath(repositoryRoot),
      "exports",
      `${checkpoint.taskId}-r${checkpoint.revision}.to-${safeId(target)}.md`
    );
  atomicWrite(destination, `${content.trimEnd()}\n`);
  return destination;
}

export function importCheckpoint(repositoryRoot: string, input: string): Checkpoint {
  const incoming = checkpointSchema.parse(JSON.parse(readFileSync(resolve(input), "utf8")));
  assertNoSecrets(incoming);
  const revision = nextRevision(repositoryRoot, incoming.taskId);
  const checkpoint: Checkpoint = {
    ...incoming,
    id: `${incoming.taskId}-r${revision}`,
    revision,
    createdAt: new Date().toISOString(),
    source: { agent: "import", cwd: repositoryRoot }
  };
  saveCheckpoint(repositoryRoot, checkpoint);
  return checkpoint;
}

export function checkpointLabel(checkpoint: Checkpoint): string {
  return `${checkpoint.taskId} r${checkpoint.revision} (${basename(checkpoint.repository.root)})`;
}
