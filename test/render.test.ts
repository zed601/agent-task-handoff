import { describe, expect, it } from "vitest";
import { launchSpec, renderHandoffPrompt, renderHumanHandoff, resumeLaunchSpec } from "../src/render.js";
import { checkpointFixture } from "./helpers.js";

describe("target renderers", () => {
  it("renders provenance, evidence, and rejected attempts", () => {
    const prompt = renderHandoffPrompt(checkpointFixture("/repo"), "codex");
    expect(prompt).toContain("[user-stated] Fix duplicate login requests");
    expect(prompt).toContain("Do not retry rejected");
    expect(prompt).toContain("Use a global lock");
  });

  it("renders an exact target session name", () => {
    const prompt = renderHandoffPrompt(checkpointFixture("/repo"), "claude", {
      sessionName: "handoff-payments"
    });
    expect(prompt).toContain("Name this claude session exactly: handoff-payments");
  });

  it("compacts large changed-file lists by top-level path", () => {
    const checkpoint = checkpointFixture("/repo");
    checkpoint.repository.changedFiles = [
      ".gitignore",
      ...Array.from({ length: 1000 }, (_, index) => `.pnpm-store/v11/files/${index}`),
      ...Array.from({ length: 12 }, (_, index) => `src/file-${index}.ts`)
    ];
    const prompt = renderHandoffPrompt(checkpoint, "claude");
    expect(prompt).toContain("Changed files: 1013 total");
    expect(prompt).toContain(".pnpm-store/ (1000 files)");
    expect(prompt).toContain("src/ (12 files)");
    expect(prompt).not.toContain(".pnpm-store/v11/files/999");
    expect(prompt.length).toBeLessThan(5000);
  });

  it("builds argument arrays without a shell", () => {
    expect(launchSpec("codex", "/repo", "prompt")).toEqual({
      command: "codex",
      args: ["-C", "/repo", "prompt"],
      cwd: "/repo"
    });
    expect(launchSpec("opencode", "/repo", "prompt").args).toEqual(["/repo", "--prompt", "prompt"]);
    expect(launchSpec("opencode", "/repo", "prompt", { sessionId: "ses_abc" }).args)
      .toEqual(["/repo", "--session", "ses_abc", "--prompt", "prompt"]);
    expect(launchSpec("claude", "/repo", "prompt", {
      sessionId: "d018c05a-0552-4c0d-9aef-2471cb6d225d",
      sessionName: "handoff-payments"
    })).toEqual({
      command: "claude",
      args: [
        "--session-id", "d018c05a-0552-4c0d-9aef-2471cb6d225d",
        "--name", "handoff-payments",
        "prompt"
      ],
      cwd: "/repo"
    });
    expect(launchSpec("copilot", "/repo", "prompt")).toEqual({
      command: "copilot",
      args: ["-C", "/repo", "-i", "prompt"],
      cwd: "/repo"
    });
    expect(launchSpec("cursor", "/repo", "prompt")).toEqual({
      command: "agent",
      args: ["prompt"],
      cwd: "/repo"
    });
  });

  it("resumes Claude by UUID, Codex by name or last, and OpenCode by continue or session", () => {
    expect(resumeLaunchSpec("claude", "/repo", "d018c05a-0552-4c0d-9aef-2471cb6d225d")).toEqual({
      command: "claude",
      args: ["--resume", "d018c05a-0552-4c0d-9aef-2471cb6d225d"],
      cwd: "/repo"
    });
    expect(resumeLaunchSpec("codex", "/repo", "handoff-payments")).toEqual({
      command: "codex",
      args: ["resume", "handoff-payments"],
      cwd: "/repo"
    });
    expect(resumeLaunchSpec("codex", "/repo", "__last__")).toEqual({
      command: "codex",
      args: ["resume", "--last"],
      cwd: "/repo"
    });
    expect(resumeLaunchSpec("opencode", "/repo", "__last__")).toEqual({
      command: "opencode",
      args: ["/repo", "--continue"],
      cwd: "/repo"
    });
    expect(resumeLaunchSpec("opencode", "/repo", "ses_abc")).toEqual({
      command: "opencode",
      args: ["/repo", "--session", "ses_abc"],
      cwd: "/repo"
    });
    expect(() => resumeLaunchSpec("cursor", "/repo", "x")).toThrow(/not implemented/);
  });

  it("renders a human-readable Markdown handoff", () => {
    const markdown = renderHumanHandoff(checkpointFixture("/repo"));
    expect(markdown).toContain("# Task Handoff: fix-login");
    expect(markdown).toContain("## Failed or Rejected Attempts");
    expect(markdown).toContain("Add the concurrency test");
  });
});
