import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function text(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

describe("agent integrations", () => {
  it("keeps the shared skill identical in both plugins", () => {
    const canonical = text("skills/handoff-task/SKILL.md");
    expect(text("integrations/codex-plugin/skills/handoff-task/SKILL.md")).toBe(canonical);
    expect(text("integrations/claude-marketplace/plugins/taskhandoff/skills/handoff-task/SKILL.md")).toBe(canonical);
  });

  it("declares valid matching plugin identities", () => {
    const packageVersion = (JSON.parse(text("package.json")) as { version: string }).version;
    const codex = JSON.parse(text("integrations/codex-plugin/.codex-plugin/plugin.json")) as { name: string; skills: string; version: string };
    const claude = JSON.parse(text("integrations/claude-marketplace/plugins/taskhandoff/.claude-plugin/plugin.json")) as { name: string; version: string };
    const marketplace = JSON.parse(text("integrations/claude-marketplace/.claude-plugin/marketplace.json")) as {
      version: string;
      plugins: Array<{ name: string; source: string; version: string }>;
    };
    expect(codex).toMatchObject({ name: "taskhandoff", skills: "./skills/", version: packageVersion });
    expect(claude).toMatchObject({ name: "taskhandoff", version: packageVersion });
    expect(marketplace.version).toBe(packageVersion);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "taskhandoff",
      source: "./plugins/taskhandoff",
      version: packageVersion
    });
  });

  it("provides a Claude slash command backed by the CLI", () => {
    const command = text("integrations/claude-marketplace/plugins/taskhandoff/commands/handoff.md");
    expect(command).toContain("allowed-tools: Bash(handoff:*)");
    expect(command).toContain("handoff doctor --json");
    expect(command).toContain("$ARGUMENTS");
  });
});
