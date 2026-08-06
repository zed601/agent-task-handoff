import { spawn, spawnSync } from "node:child_process";

export const LAUNCH_MODES = ["auto", "inline", "terminal"] as const;
export type LaunchMode = typeof LAUNCH_MODES[number];
export type ResolvedLaunchMode = Exclude<LaunchMode, "auto">;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; allowFailure?: boolean; input?: string } = {}
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    shell: false
  });

  if (result.error) {
    if (options.allowFailure) {
      return { stdout: "", stderr: result.error.message, exitCode: 127 };
    }
    throw result.error;
  }

  const exitCode = result.status ?? 1;
  const commandResult = {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode
  };
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} exited with ${exitCode}: ${commandResult.stderr.trim()}`
    );
  }
  return commandResult;
}

export function commandExists(command: string): boolean {
  return runCommand("which", [command], {
    allowFailure: true
  }).exitCode === 0;
}

export function isAgentHostedEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(
    environment.CODEX_THREAD_ID ||
    environment.CLAUDECODE ||
    environment.CLAUDE_CODE_ENTRYPOINT ||
    environment.CURSOR_AGENT ||
    environment.CURSOR_AGENT_ID ||
    environment.COPILOT_CLI_SESSION_ID
  );
}

export function supportsVisibleTerminal(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

export function resolveLaunchMode(
  requested: LaunchMode,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ResolvedLaunchMode {
  if (requested !== "auto") return requested;
  return isAgentHostedEnvironment(environment) && supportsVisibleTerminal(platform)
    ? "terminal"
    : "inline";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function macTerminalScript(
  command: string,
  args: string[],
  cwd: string
): string {
  const shellCommand = [
    "cd", "--", shellQuote(cwd), "&&", "exec", shellQuote(command),
    ...args.map(shellQuote)
  ].join(" ");
  return `tell application "Terminal"\nactivate\ndo script ${appleScriptString(shellCommand)}\nend tell`;
}

export function linuxTerminalCandidates(
  command: string,
  args: string[],
  cwd: string
): Array<{ command: string; args: string[] }> {
  const shellCommand = [
    "cd", "--", shellQuote(cwd), "&&", "exec", shellQuote(command),
    ...args.map(shellQuote)
  ].join(" ");
  return [
    { command: "gnome-terminal", args: ["--", "bash", "-lc", shellCommand] },
    { command: "konsole", args: ["-e", "bash", "-lc", shellCommand] },
    { command: "xfce4-terminal", args: ["-e", `bash -lc ${shellQuote(shellCommand)}`] },
    { command: "x-terminal-emulator", args: ["-e", "bash", "-lc", shellCommand] },
    { command: "xterm", args: ["-e", "bash", "-lc", shellCommand] }
  ];
}

export function windowsTerminalArgs(
  command: string,
  args: string[],
  cwd: string
): { command: string; args: string[] } {
  if (commandExists("wt")) {
    return { command: "wt", args: ["-d", cwd, command, ...args] };
  }
  return {
    command: "cmd.exe",
    args: ["/c", "start", "", "/D", cwd, command, ...args]
  };
}

/** Open the target in a visible OS terminal window. */
export function spawnInVisibleTerminal(
  command: string,
  args: string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === "darwin") {
    const result = runCommand("osascript", ["-e", macTerminalScript(command, args, cwd)], {
      allowFailure: true
    });
    if (result.exitCode !== 0) {
      throw new Error(`Could not open Terminal: ${result.stderr.trim() || `osascript exited with ${result.exitCode}`}`);
    }
    return;
  }

  if (platform === "win32") {
    const spec = windowsTerminalArgs(command, args, cwd);
    const result = runCommand(spec.command, spec.args, { allowFailure: true });
    if (result.exitCode !== 0) {
      throw new Error(`Could not open a terminal window: ${result.stderr.trim() || `${spec.command} exited with ${result.exitCode}`}`);
    }
    return;
  }

  if (platform === "linux") {
    for (const candidate of linuxTerminalCandidates(command, args, cwd)) {
      if (!commandExists(candidate.command)) continue;
      const result = runCommand(candidate.command, candidate.args, { allowFailure: true });
      if (result.exitCode === 0) return;
    }
    throw new Error("No supported Linux terminal emulator found; use --launch-mode inline");
  }

  throw new Error(`Terminal launch mode is not supported on ${platform}; use --launch-mode inline`);
}

/** @deprecated Use spawnInVisibleTerminal */
export function spawnInMacTerminal(
  command: string,
  args: string[],
  cwd: string
): void {
  spawnInVisibleTerminal(command, args, cwd, "darwin");
}

export function spawnInteractive(
  command: string,
  args: string[],
  cwd: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
