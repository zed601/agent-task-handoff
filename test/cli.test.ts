import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeGitRepository } from "./helpers.js";

const cli = resolve("dist/cli.js");

function handoff(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" }
  });
}

describe("CLI integration", () => {
  it("runs init, checkpoint, inspect, verify, export, and import", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-cli-"));
    initializeGitRepository(root);
    handoff(root, "init");
    expect(existsSync(join(root, ".handoff", "config.yaml"))).toBe(true);

    handoff(
      root,
      "checkpoint",
      "--yes",
      "--task", "login",
      "--goal", "Fix duplicate login requests",
      "--acceptance", "All tests pass",
      "--next", "Add a concurrency test",
      "--ref", "README.md"
    );
    const checkpoint = JSON.parse(handoff(root, "inspect", "login", "--json")) as {
      taskId: string;
      revision: number;
    };
    expect(checkpoint).toMatchObject({ taskId: "login", revision: 1 });
    expect(handoff(root, "verify", "login")).toContain("FRESH");
    expect(JSON.parse(handoff(root, "doctor", "--json"))).toMatchObject({
      initialized: true,
      latestTask: "login",
      nextSteps: expect.arrayContaining([expect.stringContaining("handoff go")]),
      agents: {
        copilot: expect.any(Boolean),
        cursor: expect.any(Boolean)
      }
    });

    expect(handoff(root, "resume", "login", "--to", "copilot")).toContain("Task handoff for copilot");
    expect(handoff(root, "resume", "login", "--to", "cursor")).toContain("Task handoff for cursor");

    const transfer = JSON.parse(handoff(
      root,
      "transfer",
      "login",
      "--to", "claude",
      "--name", "handoff-login",
      "--no-copy",
      "--json"
    )) as {
      taskId: string;
      revision: number;
      freshness: string;
      target: string;
      targetSessionName: string;
      promptPath: string;
      copied: boolean;
    };
    expect(transfer).toMatchObject({
      taskId: "login",
      revision: 1,
      freshness: "FRESH",
      target: "claude",
      targetSessionName: "handoff-login",
      copied: false
    });
    expect(existsSync(transfer.promptPath)).toBe(true);
    expect(readFileSync(transfer.promptPath, "utf8")).toContain(
      "Name this claude session exactly: handoff-login"
    );

    const portable = join(root, "portable.json");
    handoff(root, "export", "login", "--output", portable);
    expect(existsSync(portable)).toBe(true);
    handoff(root, "import", portable);
    expect(JSON.parse(handoff(root, "inspect", "login", "--json")).revision).toBe(2);
    const markdown = join(root, "handoff.md");
    handoff(root, "export", "login", "--format", "markdown", "--output", markdown);
    expect(existsSync(markdown)).toBe(true);
  });

  it("auto-initializes and delivers with handoff go", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-cli-"));
    initializeGitRepository(root);
    writeFileSync(join(root, "src-file.ts"), "export {}\n", "utf8");
    expect(existsSync(join(root, ".handoff"))).toBe(false);

    const receipt = JSON.parse(handoff(
      root,
      "go",
      "--to", "human",
      "--task", "login",
      "--goal", "Fix login",
      "--completed", "Found the bug",
      "--no-copy",
      "--json"
    )) as {
      taskId: string;
      revision: number;
      target: string;
      launched: boolean;
      promptPath: string;
      freshness: string;
    };

    expect(existsSync(join(root, ".handoff", "config.yaml"))).toBe(true);
    expect(receipt).toMatchObject({
      taskId: "login",
      revision: 1,
      target: "human",
      launched: false,
      freshness: "FRESH"
    });
    expect(existsSync(receipt.promptPath)).toBe(true);
    const prompt = readFileSync(receipt.promptPath, "utf8");
    expect(prompt).toContain("Fix login");
    expect(prompt).toContain("src-file.ts");

    const again = JSON.parse(handoff(
      root,
      "go",
      "login",
      "--to", "codex",
      "--name", "handoff-login",
      "--no-exec",
      "--no-copy",
      "--json"
    )) as { launched: boolean; targetSessionName: string };
    expect(again).toMatchObject({
      launched: false,
      targetSessionName: "handoff-login"
    });
  });

  it("snaps a goal with dirty files and guides the next go", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-cli-"));
    initializeGitRepository(root);
    writeFileSync(join(root, "feature.ts"), "export const x = 1\n", "utf8");

    const snap = JSON.parse(handoff(
      root,
      "snap",
      "--goal", "Ship feature flag",
      "--json"
    )) as {
      taskId: string;
      revision: number;
      refs: string[];
      next: string;
      path: string;
    };

    expect(snap.taskId).toContain("ship-feature");
    expect(snap.revision).toBe(1);
    expect(snap.refs).toContain("feature.ts");
    expect(snap.next).toBe(`handoff go ${snap.taskId}`);
    expect(existsSync(snap.path)).toBe(true);

    const transferred = JSON.parse(handoff(
      root,
      "go",
      snap.taskId,
      "--to", "human",
      "--no-copy",
      "--json"
    )) as { taskId: string; launched: boolean };
    expect(transferred).toMatchObject({ taskId: snap.taskId, launched: false });
  });

  it("returns exit code 2 for stale evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-cli-"));
    initializeGitRepository(root);
    handoff(root, "init");
    handoff(root, "checkpoint", "--yes", "--task", "stale", "--goal", "Test staleness", "--next", "Change a file");
    appendFileSync(join(root, "README.md"), "changed\n", "utf8");
    const result = spawnSync(process.execPath, [cli, "verify", "stale"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("STALE");
  });

  it("launches and re-enters a native named Claude session", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-cli-"));
    const bin = mkdtempSync(join(tmpdir(), "handoff-bin-"));
    const argsPath = join(root, "claude-args.json");
    const fakeClaude = join(bin, "claude");
    initializeGitRepository(root);
    handoff(root, "init");
    handoff(root, "checkpoint", "--yes", "--task", "login", "--goal", "Fix login", "--next", "Run tests");
    writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.HANDOFF_TEST_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
      "utf8"
    );
    chmodSync(fakeClaude, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      HANDOFF_TEST_ARGS: argsPath,
      NO_COLOR: "1"
    };

    const transfer = JSON.parse(execFileSync(process.execPath, [
      cli,
      "transfer", "login",
      "--to", "claude",
      "--name", "handoff-login",
      "--exec",
      "--launch-mode", "inline",
      "--no-copy",
      "--json"
    ], { cwd: root, encoding: "utf8", env })) as {
      launched: boolean;
      launchMode: string;
      launchReceiptPath: string;
      resumeCommand: string;
      targetSessionId: string;
      targetSessionName: string;
    };

    expect(transfer).toMatchObject({
      launched: true,
      launchMode: "inline",
      targetSessionName: "handoff-login"
    });
    expect(transfer.targetSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(transfer.resumeCommand).toBe(`claude --resume ${transfer.targetSessionId}`);
    expect(existsSync(transfer.launchReceiptPath)).toBe(true);
    expect(JSON.parse(readFileSync(argsPath, "utf8")).slice(0, 4)).toEqual([
      "--session-id", transfer.targetSessionId,
      "--name", "handoff-login"
    ]);

    const entered = JSON.parse(execFileSync(process.execPath, [
      cli,
      "enter", "login",
      "--to", "claude",
      "--launch-mode", "inline",
      "--json"
    ], { cwd: root, encoding: "utf8", env })) as { sessionId: string; sessionName: string };
    expect(entered).toMatchObject({
      sessionId: transfer.targetSessionId,
      sessionName: "handoff-login"
    });
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
      "--resume", transfer.targetSessionId
    ]);
  });

  it("launches and re-enters a named Codex session", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-cli-"));
    const bin = mkdtempSync(join(tmpdir(), "handoff-bin-"));
    const argsPath = join(root, "codex-args.json");
    const fakeCodex = join(bin, "codex");
    initializeGitRepository(root);
    handoff(root, "init");
    handoff(root, "checkpoint", "--yes", "--task", "login", "--goal", "Fix login", "--next", "Run tests");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.HANDOFF_TEST_ARGS, JSON.stringify(process.argv.slice(2)));\n`,
      "utf8"
    );
    chmodSync(fakeCodex, 0o755);
    const env = {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      HANDOFF_TEST_ARGS: argsPath,
      NO_COLOR: "1"
    };

    const transfer = JSON.parse(execFileSync(process.execPath, [
      cli,
      "go", "login",
      "--to", "codex",
      "--name", "handoff-login",
      "--exec",
      "--launch-mode", "inline",
      "--no-copy",
      "--json"
    ], { cwd: root, encoding: "utf8", env })) as {
      launched: boolean;
      resumeCommand: string;
      targetSessionId: string;
      targetSessionName: string;
    };

    expect(transfer).toMatchObject({
      launched: true,
      targetSessionId: "handoff-login",
      targetSessionName: "handoff-login",
      resumeCommand: "codex resume handoff-login"
    });
    const launchedArgs = JSON.parse(readFileSync(argsPath, "utf8")) as string[];
    expect(launchedArgs[0]).toBe("-C");
    expect(launchedArgs.at(-1)).toContain("Task handoff for codex");

    const entered = JSON.parse(execFileSync(process.execPath, [
      cli,
      "enter", "login",
      "--to", "codex",
      "--launch-mode", "inline",
      "--json"
    ], { cwd: root, encoding: "utf8", env })) as { sessionId: string; sessionName: string };
    expect(entered).toMatchObject({
      sessionId: "handoff-login",
      sessionName: "handoff-login"
    });
    expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
      "resume", "handoff-login"
    ]);
  });
});
