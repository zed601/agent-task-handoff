import { describe, expect, it } from "vitest";
import {
  isAgentHostedEnvironment,
  linuxTerminalCandidates,
  macTerminalScript,
  resolveLaunchMode,
  shellQuote,
  supportsVisibleTerminal,
  windowsTerminalArgs
} from "../src/process.js";

describe("target launch process", () => {
  it("uses a visible terminal for agent-hosted launches across platforms", () => {
    expect(resolveLaunchMode("auto", { CODEX_THREAD_ID: "thread" }, "darwin")).toBe("terminal");
    expect(resolveLaunchMode("auto", { CURSOR_AGENT: "1" }, "linux")).toBe("terminal");
    expect(resolveLaunchMode("auto", { COPILOT_CLI_SESSION_ID: "s" }, "win32")).toBe("terminal");
    expect(resolveLaunchMode("auto", {}, "darwin")).toBe("inline");
    expect(resolveLaunchMode("auto", { CLAUDECODE: "1" }, "linux")).toBe("terminal");
    expect(resolveLaunchMode("inline", { CODEX_THREAD_ID: "thread" }, "darwin")).toBe("inline");
    expect(isAgentHostedEnvironment({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
    expect(supportsVisibleTerminal("linux")).toBe(true);
  });

  it("quotes terminal launch arguments without embedding prompt contents", () => {
    expect(shellQuote("it's safe")).toBe("'it'\"'\"'s safe'");
    const script = macTerminalScript(
      "/usr/local/bin/node",
      ["/app/cli.js", "_launch", "/repo/.handoff/prompt file.md", "--name", "上下文续接"],
      "/repo with spaces"
    );
    expect(script).toContain("tell application \"Terminal\"");
    expect(script).toContain("'/repo/.handoff/prompt file.md'");
    expect(script).toContain("'上下文续接'");
    expect(script).not.toContain("Task handoff for claude");

    const linux = linuxTerminalCandidates(
      "/usr/bin/node",
      ["/app/cli.js", "_launch", "/repo/.handoff/prompt.md"],
      "/repo"
    );
    expect(linux[0]?.command).toBe("gnome-terminal");
    expect(linux[0]?.args.join(" ")).toContain("/repo/.handoff/prompt.md");

    const windows = windowsTerminalArgs(
      "C:\\node.exe",
      ["C:\\cli.js", "_launch", "C:\\prompt.md"],
      "C:\\repo"
    );
    expect(["wt", "cmd.exe"]).toContain(windows.command);
    expect(windows.args).toContain("C:\\prompt.md");
  });
});
