import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRepositoryState } from "../src/git.js";
import {
  ensureInitialized,
  initializeHandoff,
  isInitialized,
  loadCheckpoint,
  loadLaunchReceipt,
  nextRevision,
  saveCheckpoint,
  saveLaunchReceipt
} from "../src/store.js";
import { checkpointFixture, initializeGitRepository } from "./helpers.js";

describe("checkpoint store", () => {
  it("stores immutable revisions and a latest pointer", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-store-"));
    initializeGitRepository(root);
    initializeHandoff(root);
    const checkpoint = checkpointFixture(root);
    checkpoint.repository = collectRepositoryState(root);
    const path = saveCheckpoint(root, checkpoint);
    expect(existsSync(path)).toBe(true);
    expect(loadCheckpoint(root, "fix-login").id).toBe("fix-login-r1");
    expect(nextRevision(root, "fix-login")).toBe(2);
    expect(() => saveCheckpoint(root, checkpoint)).toThrow(/already exists/);
  });

  it("stores a resumable target-session receipt", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-store-"));
    initializeGitRepository(root);
    initializeHandoff(root);
    const receipt = {
      version: 1 as const,
      taskId: "fix-login",
      revision: 1,
      target: "claude",
      sessionId: "d018c05a-0552-4c0d-9aef-2471cb6d225d",
      sessionName: "handoff-login",
      repositoryRoot: root,
      promptPath: join(root, ".handoff", "exports", "login.md"),
      createdAt: "2026-08-05T05:00:00.000Z"
    };
    expect(existsSync(saveLaunchReceipt(root, receipt))).toBe(true);
    expect(loadLaunchReceipt(root, "fix-login", "claude")).toEqual(receipt);
    expect(loadLaunchReceipt(root)).toEqual(receipt);
  });

  it("lazy-initializes config with defaultExec", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-store-"));
    initializeGitRepository(root);
    expect(isInitialized(root)).toBe(false);
    const first = ensureInitialized(root);
    expect(first.created).toBe(true);
    expect(first.config.defaultExec).toBe(false);
    expect(first.config.defaultAgent).toBe("codex");
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".handoff/");
    const second = ensureInitialized(root);
    expect(second.created).toBe(false);
  });
});
