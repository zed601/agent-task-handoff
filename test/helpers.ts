import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { type Checkpoint, SCHEMA_VERSION } from "../src/schema.js";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function initializeGitRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  writeFileSync(`${root}/README.md`, "# Fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "initial");
}

export function checkpointFixture(root: string): Checkpoint {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "fix-login-r1",
    taskId: "fix-login",
    revision: 1,
    createdAt: now,
    source: { agent: "manual", cwd: root },
    task: {
      goal: { text: "Fix duplicate login requests", provenance: "user-stated", evidence: [] },
      acceptance: [{ text: "All tests pass", provenance: "user-stated", evidence: [] }],
      status: "active"
    },
    progress: {
      completed: [{ text: "Located the handler", provenance: "observed", evidence: ["src/login.ts"] }],
      pending: []
    },
    decisions: [],
    attempts: [{
      approach: { text: "Use a global lock", provenance: "agent-inferred", evidence: [] },
      result: "rejected",
      reason: { text: "It does not work across processes", provenance: "observed", evidence: [] }
    }],
    blockers: [],
    nextAction: { text: "Add the concurrency test", provenance: "user-stated", evidence: [] },
    repository: {
      root,
      branch: "main",
      head: "0123456789012345678901234567890123456789",
      dirty: false,
      statusHash: "a".repeat(64),
      changedFiles: [],
      diffStat: "",
      fileHashes: {}
    },
    verification: [],
    contextRefs: [{ path: "src/login.ts", symbols: ["login"], reason: "main handler" }],
    capabilities: { requiredTools: ["git"], requiredPermissions: [] },
    freshness: { checkedAt: now, stale: false, reasons: [] }
  };
}
