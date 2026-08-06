import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { draftFromSession, parseSessionFile, resolveOpenCodeResumeSessionId, sessionSummaryJsonSchema, summarizeSession } from "../src/session.js";

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
    const draft = draftFromSession(candidate);
    expect(draft.completed.some((item) => /completed the database constraint/i.test(item))).toBe(true);
    expect(draft.completed.some((item) => /pnpm test/i.test(item))).toBe(true);
    expect(draft.nextAction.toLowerCase()).toContain("idempotency");
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

  it("extracts decisions, attempts, blockers, and pending from visible session text", () => {
    const draft = draftFromSession({
      agent: "claude",
      path: "fixture",
      messages: [
        {
          role: "user",
          text: "Fix webhook retries. Acceptance: must be idempotent under duplicate delivery. We decided to use a ledger table."
        },
        {
          role: "assistant",
          text: "I implemented the unique constraint. The in-memory cache approach failed under concurrency. Blocked on missing staging credentials. Next step is wire the outbox publisher."
        },
        { role: "user", text: "ok" }
      ],
      commands: ["pnpm test src/webhook.test.ts"],
      files: ["src/webhook.ts", "src/ledger.ts"]
    });

    expect(draft.goal).toMatch(/Fix webhook retries/i);
    expect(draft.acceptance.some((item) => /idempotent/i.test(item))).toBe(true);
    expect(draft.decisions.some((item) => /ledger table/i.test(item))).toBe(true);
    expect(draft.attempts.some((item) => /in-memory cache/i.test(item.approach))).toBe(true);
    expect(draft.blockers.some((item) => /staging credentials/i.test(item))).toBe(true);
    expect(draft.pending.some((item) => /outbox publisher/i.test(item))).toBe(true);
    expect(draft.nextAction).toMatch(/outbox publisher/i);
    expect(draft.contextPaths).toEqual(["src/webhook.ts", "src/ledger.ts"]);
    expect(draft.completed.some((item) => /unique constraint/i.test(item))).toBe(true);
  });

  it("prefers the latest high-signal goal and dedupes near-duplicate failed attempts", () => {
    const draft = draftFromSession({
      agent: "codex",
      path: "fixture",
      messages: [
        { role: "user", text: "Please look around the repository first." },
        { role: "assistant", text: "I explored the tree." },
        {
          role: "user",
          text: "Finish the webhook retry queue in src/webhook.ts so duplicate deliveries are safe."
        },
        {
          role: "assistant",
          text: "The naive mutex approach failed under load. The naive mutex approach failed again with the same races. Next step is add an outbox."
        }
      ],
      commands: [],
      files: ["src/webhook.ts"]
    });
    expect(draft.goal).toMatch(/webhook retry queue/i);
    expect(draft.attempts).toHaveLength(1);
    expect(draft.attempts[0]?.approach).toMatch(/naive mutex/i);
    expect(draft.nextAction).toMatch(/outbox/i);
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

  it("uses local heuristic drafts for OpenCode --summarize", () => {
    const draft = summarizeSession({
      agent: "opencode",
      path: "opencode:fixture",
      messages: [
        { role: "user", text: "Finish the webhook retry queue in src/webhook.ts" },
        { role: "assistant", text: "I implemented the first worker loop. Next step is add backoff." }
      ],
      commands: ["pnpm test"],
      files: ["src/webhook.ts"]
    });
    expect(draft.goal).toMatch(/webhook retry queue/i);
    expect(draft.completed.some((item) => /worker loop|pnpm test/i.test(item))).toBe(true);
    expect(draft.nextAction).toMatch(/backoff/i);
  });

  it("resolves OpenCode resume ids from session list when receipt is __last__", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-opencode-repo-"));
    const bin = mkdtempSync(join(tmpdir(), "handoff-opencode-bin-"));
    const executable = join(bin, "opencode");
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "session" ] && [ "$2" = "list" ]; then
  printf '%s' "[{\\"id\\":\\"ses_old\\",\\"directory\\":\\"/other\\",\\"title\\":\\"other\\",\\"updated\\":1},{\\"id\\":\\"ses_new\\",\\"directory\\":\\"${root}\\",\\"title\\":\\"handoff-login\\",\\"updated\\":9}]"
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      expect(resolveOpenCodeResumeSessionId(root, "__last__", "handoff-login")).toBe("ses_new");
      expect(resolveOpenCodeResumeSessionId(root, "__last__")).toBe("ses_new");
      expect(resolveOpenCodeResumeSessionId(root, "ses_explicit")).toBe("ses_explicit");
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("resolves OpenCode resume ids with title and launch-time window", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-opencode-repo-"));
    const bin = mkdtempSync(join(tmpdir(), "handoff-opencode-bin-"));
    const executable = join(bin, "opencode");
    const launchedAt = "2026-08-06T12:00:00.000Z";
    const launchedMs = Date.parse(launchedAt);
    writeFileSync(executable, `#!/bin/sh
if [ "$1" = "session" ] && [ "$2" = "list" ]; then
  printf '%s' "[{\\"id\\":\\"ses_old\\",\\"directory\\":\\"${root}\\",\\"title\\":\\"old\\",\\"updated\\":1},{\\"id\\":\\"ses_stale\\",\\"directory\\":\\"${root}\\",\\"title\\":\\"other\\",\\"updated\\":${Math.floor((launchedMs - 86_400_000) / 1000)}},{\\"id\\":\\"ses_new\\",\\"directory\\":\\"${root}\\",\\"title\\":\\"handoff-login\\",\\"updated\\":${Math.floor(launchedMs / 1000)}}]"
  exit 0
fi
exit 1
`, "utf8");
    chmodSync(executable, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      expect(resolveOpenCodeResumeSessionId(root, "__last__", {
        sessionName: "handoff-login",
        launchedAt
      })).toBe("ses_new");
      expect(resolveOpenCodeResumeSessionId(root, "__last__", { launchedAt })).toBe("ses_new");
      expect(resolveOpenCodeResumeSessionId(root, "ses_explicit")).toBe("ses_explicit");
    } finally {
      process.env.PATH = originalPath;
    }
  });
});
