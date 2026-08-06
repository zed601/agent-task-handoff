import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { draftFromSession, parseSessionFile, sessionSummaryJsonSchema, summarizeSession } from "../src/session.js";

describe("session adapters", () => {
  it("parses Codex JSONL and ignores malformed or unknown records", () => {
    const candidate = parseSessionFile("codex", resolve("test/fixtures/codex.jsonl"));
    expect(candidate.sessionId).toBe("codex-session");
    expect(candidate.messages).toHaveLength(2);
    expect(candidate.commands).toEqual(["pnpm test"]);
    expect(candidate.files).toContain("src/webhook.ts");
  });

  it("parses Claude JSONL without sidechains", () => {
    const candidate = parseSessionFile("claude", resolve("test/fixtures/claude.jsonl"));
    expect(candidate.messages).toHaveLength(2);
    expect(candidate.commands).toEqual(["pnpm test"]);
    expect(candidate.messages.some((message) => message.text.includes("sidechain"))).toBe(false);
    expect(draftFromSession(candidate).completed).toHaveLength(1);
  });

  it("parses an OpenCode export without reasoning or tool output", () => {
    const candidate = parseSessionFile("opencode", resolve("test/fixtures/opencode.json"));
    expect(candidate.sessionId).toBe("opencode-session");
    expect(candidate.cwd).toBe("/repo");
    expect(candidate.messages).toHaveLength(2);
    expect(candidate.commands).toEqual(["pnpm test"]);
    expect(candidate.files).toContain("src/webhook.ts");
    expect(candidate.messages.some((message) => message.text.includes("hidden reasoning"))).toBe(false);
  });

  it("passes a strict JSON schema to an optional summarizer", () => {
    expect(sessionSummaryJsonSchema.additionalProperties).toBe(false);
    const bin = mkdtempSync(join(tmpdir(), "handoff-fake-agent-"));
    const executable = join(bin, "claude");
    const summary = {
      structured_output: {
        goal: "Fix the task",
        acceptance: [],
        completed: [],
        pending: ["Implement it"],
        decisions: [],
        attempts: [],
        blockers: [],
        nextAction: "Edit the handler",
        contextPaths: ["src/handler.ts"]
      }
    };
    writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(summary)}'\n`, "utf8");
    chmodSync(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      const result = summarizeSession({
        agent: "claude",
        path: "/fixture.jsonl",
        cwd: bin,
        messages: [{ role: "user", text: "Please fix the unfinished handler implementation." }],
        commands: [],
        files: []
      });
      expect(result.nextAction).toBe("Edit the handler");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("does not claim structured OpenCode summarization support", () => {
    expect(() => summarizeSession({
      agent: "opencode",
      path: "opencode:fixture",
      messages: [],
      commands: [],
      files: []
    })).toThrow("supports Claude and Codex");
  });
});
