import { type Checkpoint, type SourcedText } from "./schema.js";

export const TARGET_AGENTS = ["codex", "claude", "opencode", "copilot", "cursor"] as const;
export type TargetAgent = typeof TARGET_AGENTS[number];
export type HandoffTarget = TargetAgent | "human";

export interface HandoffPromptOptions {
  sessionName?: string;
}

export interface LaunchOptions {
  sessionId?: string;
  sessionName?: string;
}

function line(item: SourcedText): string {
  const evidence = item.evidence.length > 0 ? `; evidence: ${item.evidence.join(", ")}` : "";
  return `- [${item.provenance}] ${item.text}${evidence}`;
}

function section(title: string, values: SourcedText[]): string {
  return `## ${title}\n${values.length > 0 ? values.map(line).join("\n") : "- None recorded"}`;
}

function changedFilesSummary(paths: string[]): string {
  if (paths.length === 0) return "- Changed files: none";
  if (paths.length <= 40) return `- Changed files (${paths.length}): ${paths.join(", ")}`;

  const groups = new Map<string, number>();
  for (const path of paths) {
    const separator = path.indexOf("/");
    const group = separator === -1 ? path : `${path.slice(0, separator)}/`;
    groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const summary = [...groups.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([path, count]) => count === 1 ? path : `${path} (${count} files)`)
    .join(", ");
  const hiddenGroups = Math.max(0, groups.size - 20);
  return `- Changed files: ${paths.length} total\n` +
    `- Changed path summary: ${summary}${hiddenGroups > 0 ? `, … ${hiddenGroups} more top-level paths` : ""}\n` +
    `- Inspect exact paths with \`git status --short\`; the complete status fingerprint remains in the checkpoint.`;
}

export function renderHandoffPrompt(
  checkpoint: Checkpoint,
  target: TargetAgent,
  options: HandoffPromptOptions = {}
): string {
  const attempts = checkpoint.attempts.length > 0
    ? checkpoint.attempts.map((attempt) =>
      `- [${attempt.result}] ${attempt.approach.text} — ${attempt.reason.text}`
    ).join("\n")
    : "- None recorded";
  const verification = checkpoint.verification.length > 0
    ? checkpoint.verification.map((item) =>
      `- \`${item.command}\` exited ${item.exitCode} at ${item.recordedAt}: ${item.outputSummary}`
    ).join("\n")
    : "- None recorded";
  const refs = checkpoint.contextRefs.length > 0
    ? checkpoint.contextRefs.map((ref) =>
      `- ${ref.path}${ref.symbols.length > 0 ? ` (${ref.symbols.join(", ")})` : ""}: ${ref.reason}`
    ).join("\n")
    : "- None recorded";
  const stale = checkpoint.freshness.stale
    ? `STALE: ${checkpoint.freshness.reasons.join("; ")}`
    : "Fresh when checkpointed; verify again before editing.";
  const targetSession = options.sessionName
    ? `## Target session\nName this ${target} session exactly: ${options.sessionName}\n\n`
    : "";

  return `# Task handoff for ${target}\n\n` +
    `You are taking over an unfinished coding task. Treat observed evidence as facts, user-stated items as requirements, and agent-inferred items as hypotheses that must be checked.\n\n` +
    targetSession +
    `Before changing code:\n1. Confirm the repository HEAD and working tree match the recorded state.\n2. Re-run or inspect stale verification evidence.\n3. Do not retry rejected or failed approaches unless new evidence justifies it.\n4. Continue from the recorded next action and preserve existing user changes.\n\n` +
    `## Task\n${line(checkpoint.task.goal)}\n` +
    `Status: ${checkpoint.task.status}\n\n` +
    section("Acceptance criteria", checkpoint.task.acceptance) + "\n\n" +
    section("Completed", checkpoint.progress.completed) + "\n\n" +
    section("Pending", checkpoint.progress.pending) + "\n\n" +
    section("Decisions", checkpoint.decisions) + "\n\n" +
    `## Attempts not to repeat\n${attempts}\n\n` +
    section("Blockers", checkpoint.blockers) + "\n\n" +
    `## Next action\n${line(checkpoint.nextAction)}\n\n` +
    `## Repository evidence\n- Root: ${checkpoint.repository.root}\n- Branch: ${checkpoint.repository.branch}\n- HEAD: ${checkpoint.repository.head}\n- Dirty: ${checkpoint.repository.dirty}\n${changedFilesSummary(checkpoint.repository.changedFiles)}\n- Freshness: ${stale}\n\n` +
    `## Verification evidence\n${verification}\n\n` +
    `## Relevant context\n${refs}\n\n` +
    `When you make meaningful progress, create a new TaskHandoff checkpoint revision.`;
}

export function renderHumanHandoff(checkpoint: Checkpoint): string {
  const list = (items: SourcedText[]) => items.length > 0
    ? items.map((item) => `- ${item.text} _(${item.provenance})_`).join("\n")
    : "- None recorded";
  const attempts = checkpoint.attempts.length > 0
    ? checkpoint.attempts.map((attempt) =>
      `- **${attempt.approach.text}** — ${attempt.reason.text} (${attempt.result})`
    ).join("\n")
    : "- None recorded";
  const verification = checkpoint.verification.length > 0
    ? checkpoint.verification.map((item) =>
      `- \`${item.command}\` → exit ${item.exitCode}: ${item.outputSummary}`
    ).join("\n")
    : "- None recorded";
  const refs = checkpoint.contextRefs.length > 0
    ? checkpoint.contextRefs.map((ref) => `- \`${ref.path}\`${ref.reason ? ` — ${ref.reason}` : ""}`).join("\n")
    : "- None recorded";

  return `# Task Handoff: ${checkpoint.taskId}\n\n` +
    `**Revision:** ${checkpoint.revision}  \n` +
    `**Status:** ${checkpoint.task.status}  \n` +
    `**Created:** ${checkpoint.createdAt}\n\n` +
    `## Goal\n\n${checkpoint.task.goal.text} _(${checkpoint.task.goal.provenance})_\n\n` +
    `## Acceptance Criteria\n\n${list(checkpoint.task.acceptance)}\n\n` +
    `## Completed\n\n${list(checkpoint.progress.completed)}\n\n` +
    `## Pending\n\n${list(checkpoint.progress.pending)}\n\n` +
    `## Decisions\n\n${list(checkpoint.decisions)}\n\n` +
    `## Failed or Rejected Attempts\n\n${attempts}\n\n` +
    `## Blockers\n\n${list(checkpoint.blockers)}\n\n` +
    `## Next Action\n\n${checkpoint.nextAction.text} _(${checkpoint.nextAction.provenance})_\n\n` +
    `## Repository State\n\n` +
    `- Root: \`${checkpoint.repository.root}\`\n` +
    `- Branch: \`${checkpoint.repository.branch}\`\n` +
    `- HEAD: \`${checkpoint.repository.head}\`\n` +
    `- Dirty: ${checkpoint.repository.dirty}\n` +
    `- Changed files: ${checkpoint.repository.changedFiles.length}\n\n` +
    `## Verification\n\n${verification}\n\n` +
    `## Relevant Context\n\n${refs}\n`;
}

export function launchSpec(
  target: TargetAgent,
  repositoryRoot: string,
  prompt: string,
  options: LaunchOptions = {}
): { command: string; args: string[]; cwd: string } {
  switch (target) {
    case "codex":
      return { command: "codex", args: ["-C", repositoryRoot, prompt], cwd: repositoryRoot };
    case "claude":
      return {
        command: "claude",
        args: [
          ...(options.sessionId ? ["--session-id", options.sessionId] : []),
          ...(options.sessionName ? ["--name", options.sessionName] : []),
          prompt
        ],
        cwd: repositoryRoot
      };
    case "opencode":
      return { command: "opencode", args: [repositoryRoot, "--prompt", prompt], cwd: repositoryRoot };
    case "copilot":
      return { command: "copilot", args: ["-C", repositoryRoot, "-i", prompt], cwd: repositoryRoot };
    case "cursor":
      return { command: "agent", args: [prompt], cwd: repositoryRoot };
  }
}

export function resumeLaunchSpec(
  target: TargetAgent,
  repositoryRoot: string,
  sessionId: string
): { command: string; args: string[]; cwd: string } {
  if (target === "claude") {
    return {
      command: "claude",
      args: ["--resume", sessionId],
      cwd: repositoryRoot
    };
  }
  if (target === "codex") {
    return {
      command: "codex",
      args: sessionId === "__last__"
        ? ["resume", "--last"]
        : ["resume", sessionId],
      cwd: repositoryRoot
    };
  }
  throw new Error(`Native session re-entry is not implemented for ${target}`);
}

/** Agents that TaskHandoff can reopen via `handoff enter`. */
export function supportsNativeEnter(target: TargetAgent): boolean {
  return target === "claude" || target === "codex";
}
