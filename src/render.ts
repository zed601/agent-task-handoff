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

export interface ResumeOptions {
  /** Used for weak Copilot re-entry that re-injects the saved handoff prompt. */
  prompt?: string;
}

const PROMPT_LIMITS = {
  acceptance: 8,
  completed: 8,
  pending: 8,
  decisions: 6,
  attempts: 6,
  blockers: 6,
  verification: 8,
  contextRefs: 20,
  text: 400
} as const;

function clipText(value: string, max: number = PROMPT_LIMITS.text): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function trimList<T>(values: T[], limit: number): { items: T[]; hidden: number } {
  if (values.length <= limit) return { items: values, hidden: 0 };
  return { items: values.slice(0, limit), hidden: values.length - limit };
}

function line(item: SourcedText): string {
  const evidence = item.evidence.length > 0 ? `; evidence: ${item.evidence.join(", ")}` : "";
  return `- [${item.provenance}] ${clipText(item.text)}${evidence}`;
}

function section(title: string, values: SourcedText[], limit: number): string {
  const { items, hidden } = trimList(values, limit);
  if (items.length === 0) return `## ${title}\n- None recorded`;
  const body = items.map(line).join("\n");
  const suffix = hidden > 0 ? `\n- … ${hidden} more omitted; see checkpoint revision for the full list.` : "";
  return `## ${title}\n${body}${suffix}`;
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
  const attemptsTrim = trimList(checkpoint.attempts, PROMPT_LIMITS.attempts);
  const attempts = attemptsTrim.items.length > 0
    ? attemptsTrim.items.map((attempt) =>
      `- [${attempt.result}] ${clipText(attempt.approach.text)} — ${clipText(attempt.reason.text)}`
    ).join("\n")
      + (attemptsTrim.hidden > 0
        ? `\n- … ${attemptsTrim.hidden} more omitted; see checkpoint revision for the full list.`
        : "")
    : "- None recorded";
  const verificationTrim = trimList(checkpoint.verification, PROMPT_LIMITS.verification);
  const verification = verificationTrim.items.length > 0
    ? verificationTrim.items.map((item) =>
      `- \`${item.command}\` exited ${item.exitCode} at ${item.recordedAt}: ${clipText(item.outputSummary, 200)}`
    ).join("\n")
      + (verificationTrim.hidden > 0
        ? `\n- … ${verificationTrim.hidden} more omitted; see checkpoint revision for the full list.`
        : "")
    : "- None recorded";
  const refsTrim = trimList(checkpoint.contextRefs, PROMPT_LIMITS.contextRefs);
  const refs = refsTrim.items.length > 0
    ? refsTrim.items.map((ref) =>
      `- ${ref.path}${ref.symbols.length > 0 ? ` (${ref.symbols.join(", ")})` : ""}: ${clipText(ref.reason, 160)}`
    ).join("\n")
      + (refsTrim.hidden > 0
        ? `\n- … ${refsTrim.hidden} more omitted; see checkpoint revision for the full list.`
        : "")
    : "- None recorded";
  const stale = checkpoint.freshness.stale
    ? `STALE: ${checkpoint.freshness.reasons.join("; ")}`
    : "Fresh when checkpointed; verify again before editing.";
  const targetSession = options.sessionName
    ? `## Target session\nName this ${target} session exactly: ${options.sessionName}\n\n`
    : "";
  const goal = {
    ...checkpoint.task.goal,
    text: clipText(checkpoint.task.goal.text, 800)
  };
  const nextAction = {
    ...checkpoint.nextAction,
    text: clipText(checkpoint.nextAction.text, 500)
  };

  return `# Task handoff for ${target}\n\n` +
    `You are taking over an unfinished coding task. Treat observed evidence as facts, user-stated items as requirements, and agent-inferred items as hypotheses that must be checked.\n\n` +
    targetSession +
    `Before changing code:\n1. Confirm the repository HEAD and working tree match the recorded state.\n2. Re-run or inspect stale verification evidence.\n3. Do not retry rejected or failed approaches unless new evidence justifies it.\n4. Continue from the recorded next action and preserve existing user changes.\n\n` +
    `## Task\n${line(goal)}\n` +
    `Status: ${checkpoint.task.status}\n\n` +
    section("Acceptance criteria", checkpoint.task.acceptance, PROMPT_LIMITS.acceptance) + "\n\n" +
    section("Completed", checkpoint.progress.completed, PROMPT_LIMITS.completed) + "\n\n" +
    section("Pending", checkpoint.progress.pending, PROMPT_LIMITS.pending) + "\n\n" +
    section("Decisions", checkpoint.decisions, PROMPT_LIMITS.decisions) + "\n\n" +
    `## Attempts not to repeat\n${attempts}\n\n` +
    section("Blockers", checkpoint.blockers, PROMPT_LIMITS.blockers) + "\n\n" +
    `## Next action\n${line(nextAction)}\n\n` +
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
      return {
        command: "opencode",
        args: [
          repositoryRoot,
          ...(options.sessionId && options.sessionId !== "__last__"
            ? ["--session", options.sessionId]
            : []),
          "--prompt",
          prompt
        ],
        cwd: repositoryRoot
      };
    case "copilot":
      return { command: "copilot", args: ["-C", repositoryRoot, "-i", prompt], cwd: repositoryRoot };
    case "cursor":
      return { command: "agent", args: [prompt], cwd: repositoryRoot };
  }
}

export function resumeLaunchSpec(
  target: TargetAgent,
  repositoryRoot: string,
  sessionId: string,
  options: ResumeOptions = {}
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
  if (target === "opencode") {
    return {
      command: "opencode",
      args: sessionId === "__last__"
        ? [repositoryRoot, "--continue"]
        : [repositoryRoot, "--session", sessionId],
      cwd: repositoryRoot
    };
  }
  if (target === "cursor") {
    // Cursor keeps session state itself; reopen the last agent session in this repo.
    return {
      command: "agent",
      args: ["resume"],
      cwd: repositoryRoot
    };
  }
  if (target === "copilot") {
    // Copilot has no compatible session export/resume id; re-inject the saved prompt.
    if (!options.prompt?.trim()) {
      throw new Error("Copilot re-entry requires the saved handoff prompt from the launch receipt");
    }
    return {
      command: "copilot",
      args: ["-C", repositoryRoot, "-i", options.prompt],
      cwd: repositoryRoot
    };
  }
  throw new Error(`Native session re-entry is not implemented for ${target}`);
}

/** Agents that TaskHandoff can reopen via `handoff enter`. */
export function supportsNativeEnter(target: TargetAgent): boolean {
  return TARGET_AGENTS.includes(target);
}

/** Strong native resume (UUID/name) vs weak re-entry (resume last / re-inject prompt). */
export function enterMode(target: TargetAgent): "native" | "weak" {
  if (target === "copilot" || target === "cursor") return "weak";
  return "native";
}
