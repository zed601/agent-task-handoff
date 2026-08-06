import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRepositoryState, verifyRepositoryState } from "../src/git.js";
import { git, initializeGitRepository } from "./helpers.js";

describe("Git evidence", () => {
  it("detects working-tree changes after a checkpoint", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-git-"));
    initializeGitRepository(root);
    const recorded = collectRepositoryState(root, [{ path: "README.md", symbols: [], reason: "fixture" }]);
    expect(verifyRepositoryState(recorded, root).stale).toBe(false);
    writeFileSync(join(root, "README.md"), "changed\n", "utf8");
    const result = verifyRepositoryState(recorded, root);
    expect(result.stale).toBe(true);
    expect(result.reasons).toContain("Working tree changed");
    expect(result.reasons).toContain("File changed: README.md");
  });

  it("ignores unrelated untracked churn on unborn repositories", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-unborn-"));
    git(root, "init", "-q");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test User");
    writeFileSync(join(root, "tracked.txt"), "one\n", "utf8");
    const recorded = collectRepositoryState(root, [{ path: "tracked.txt", symbols: [], reason: "fixture" }]);
    expect(recorded.head).toBe("UNBORN");
    writeFileSync(join(root, "noise.txt"), "unrelated\n", "utf8");
    const stillFresh = verifyRepositoryState(recorded, root);
    expect(stillFresh.stale).toBe(false);
    writeFileSync(join(root, "tracked.txt"), "two\n", "utf8");
    const stale = verifyRepositoryState(recorded, root);
    expect(stale.stale).toBe(true);
    expect(stale.reasons).toContain("File changed: tracked.txt");
    expect(stale.reasons).not.toContain("Working tree changed");
  });
});
