import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { confirm, input } from "@inquirer/prompts";
import clipboard from "clipboardy";
import { collectRepositoryState, findRepositoryRoot, verifyRepositoryState } from "./git.js";
import {
  commandExists,
  resolveLaunchMode,
  spawnInVisibleTerminal,
  spawnInteractive,
  type LaunchMode,
  type ResolvedLaunchMode
} from "./process.js";
import {
  launchSpec,
  renderHandoffPrompt,
  renderHumanHandoff,
  supportsNativeEnter,
  enterMode,
  TARGET_AGENTS,
  type TargetAgent,
  type HandoffTarget
} from "./render.js";
import { SCHEMA_VERSION, type Checkpoint, type HandoffConfig, type SourcedText } from "./schema.js";
import { assertNoSecrets } from "./security.js";
import {
  draftFromSession,
  loadSessionCandidate,
  summarizeSession,
  type SessionAgent,
  type SessionDraft
} from "./session.js";
import {
  checkpointLabel,
  ensureInitialized,
  isInitialized,
  loadCheckpoint,
  loadConfig,
  nextRevision,
  safeId,
  saveCheckpoint,
  saveLaunchReceipt,
  saveRenderedHandoff
} from "./store.js";

export interface CheckpointOptions {
  task?: string;
  from?: "manual" | SessionAgent;
  session?: string;
  summarize?: boolean;
  yes?: boolean;
  quiet?: boolean;
  goal?: string;
  acceptance?: string[];
  completed?: string[];
  pending?: string[];
  decision?: string[];
  attempt?: string[];
  blocker?: string[];
  next?: string;
  ref?: string[];
  status?: "active" | "blocked" | "done";
  verifyCommand?: string;
  verifyExit?: string;
  verifySummary?: string;
}

export type ResumeResult = {
  freshness: "FRESH" | "STALE";
  reasons: string[];
  prompt: string;
  outputPath?: string;
  copied: boolean;
  copyError?: string;
  launched: boolean;
  launchMode?: ResolvedLaunchMode;
  targetSessionId?: string;
  targetSessionName?: string;
  launchReceiptPath?: string;
  resumeCommand?: string;
};

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function sourced(text: string, provenance: SourcedText["provenance"]): SourcedText {
  return { text, provenance, evidence: [] };
}

function commaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function fallbackTaskId(goal: string): string {
  try {
    return safeId(goal.split(/\s+/).slice(0, 7).join(" "));
  } catch {
    return `task-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  }
}

export function openRepository(options: { quiet?: boolean } = {}): {
  root: string;
  config: HandoffConfig;
  created: boolean;
} {
  const root = findRepositoryRoot();
  const { config, created } = ensureInitialized(root);
  if (created && !options.quiet) {
    console.log(`Initialized ${resolve(root, ".handoff")}`);
  }
  return { root, config, created };
}

export function agentBinary(target: TargetAgent): string {
  return launchSpec(target, process.cwd(), "probe").command;
}

export function installedTargetAgents(): TargetAgent[] {
  return TARGET_AGENTS.filter((agent) => commandExists(agentBinary(agent)));
}

export function resolveTargetAgent(
  requested: string | undefined,
  config: HandoffConfig,
  options: { allowHumanFallback?: boolean } = {}
): HandoffTarget {
  if (requested) {
    if (![...TARGET_AGENTS, "human"].includes(requested)) {
      throw new Error(`Unsupported agent: ${requested}`);
    }
    return requested as HandoffTarget;
  }

  if (commandExists(agentBinary(config.defaultAgent))) {
    return config.defaultAgent;
  }

  const installed = installedTargetAgents();
  if (installed.length === 1) return installed[0]!;
  if (installed.length > 1) {
    throw new Error(
      `Multiple agents installed (${installed.join(", ")}). Pass --to <agent> or set defaultAgent in .handoff/config.yaml`
    );
  }
  if (options.allowHumanFallback !== false) return "human";
  throw new Error("No agent CLI found. Pass --to human, or install claude/codex/opencode/copilot/agent");
}

export function suggestContextPaths(root: string, explicit: string[] = [], limit = 20): string[] {
  if (explicit.length > 0) return explicit;
  return collectRepositoryState(root).changedFiles
    .filter((path) => !path.startsWith(".handoff/") && path !== ".gitignore")
    .slice(0, limit);
}

export function resolveShouldExec(
  options: { exec?: boolean; noExec?: boolean },
  config: HandoffConfig,
  target: HandoffTarget,
  preferExec: boolean
): boolean {
  if (target === "human") return false;
  // Commander may map --no-exec onto exec=false or a separate noExec flag.
  if (options.noExec || options.exec === false) return false;
  if (options.exec === true) return true;
  if (!preferExec && !config.defaultExec) return false;
  return commandExists(agentBinary(target as TargetAgent));
}

export function printTransferReceipt(
  checkpoint: Checkpoint,
  target: HandoffTarget,
  result: ResumeResult,
  asJson: boolean
): void {
  const receipt = {
    taskId: checkpoint.taskId,
    revision: checkpoint.revision,
    freshness: result.freshness,
    staleReasons: result.reasons,
    target,
    targetSessionName: result.targetSessionName,
    promptPath: result.outputPath,
    copied: result.copied,
    copyError: result.copyError,
    launched: result.launched,
    launchMode: result.launchMode,
    targetSessionId: result.targetSessionId,
    launchReceiptPath: result.launchReceiptPath,
    resumeCommand: result.resumeCommand
  };
  if (asJson) {
    console.log(JSON.stringify(receipt, null, 2));
    return;
  }
  console.log(`Transferred ${checkpointLabel(checkpoint)} to ${target}`);
  console.log(`Freshness: ${receipt.freshness}${receipt.staleReasons.length > 0 ? ` (${receipt.staleReasons.join("; ")})` : ""}`);
  if (result.targetSessionName) console.log(`Session name: ${result.targetSessionName}`);
  if (receipt.targetSessionId) console.log(`Session ID: ${receipt.targetSessionId}`);
  console.log(`Prompt: ${receipt.promptPath}`);
  console.log(receipt.copied
    ? receipt.launched
      ? "Clipboard: backup ready."
      : "Clipboard: ready — open the target agent and paste once."
    : `Clipboard: unavailable${receipt.copyError ? ` (${receipt.copyError})` : ""} — use the prompt file.`);
  if (receipt.launched) {
    console.log(`Target agent launched (${receipt.launchMode}).`);
    if (receipt.resumeCommand) console.log(`Resume directly: ${receipt.resumeCommand}`);
    console.log(`Re-enter with TaskHandoff: handoff enter ${checkpoint.taskId} --to ${target}`);
  }
}

export function doctorNextSteps(input: {
  initialized: boolean;
  handoffCommand: boolean;
  latestTask?: string;
  unborn: boolean;
  agents: Record<string, boolean>;
  defaultAgent: string;
}): string[] {
  const steps: string[] = [];
  const readyAgents = Object.entries(input.agents)
    .filter(([, ready]) => ready)
    .map(([name]) => name);
  const preferred = readyAgents.includes(input.defaultAgent)
    ? input.defaultAgent
    : readyAgents[0];

  if (!input.handoffCommand) {
    steps.push("Install the CLI: npm install -g agent-task-handoff  (or pnpm link --global from this repo)");
  }
  if (!input.initialized) {
    steps.push('Save and hand off: handoff go --goal "what you are doing"');
  } else if (!input.latestTask) {
    steps.push(
      preferred
        ? `Save and hand off: handoff go --goal "<goal>"`
        : 'Save progress: handoff snap --goal "<goal>"  (then install an agent CLI to transfer)'
    );
  } else {
    steps.push(
      preferred
        ? `Continue with: handoff go`
        : `Render a handoff: handoff go --to human`
    );
    if (preferred === "claude" || preferred === "codex" || preferred === "opencode") {
      steps.push(`Re-enter the last ${preferred} launch: handoff enter`);
    }
  }
  if (input.unborn) {
    steps.push("Create an initial Git commit so freshness checks can use HEAD instead of UNBORN");
  }
  if (readyAgents.length === 0) {
    steps.push("Install at least one agent CLI: claude, codex, opencode, copilot, or Cursor agent");
  }
  return steps;
}

function manualDraft(options: CheckpointOptions): SessionDraft {
  return {
    goal: options.goal ?? "",
    acceptance: options.acceptance ?? [],
    completed: options.completed ?? [],
    pending: options.pending ?? [],
    decisions: options.decision ?? [],
    attempts: (options.attempt ?? []).map((value) => {
      const [approach, ...reason] = value.split("::");
      return { approach: approach || value, reason: reason.join("::") || "No reason recorded" };
    }),
    blockers: options.blocker ?? [],
    nextAction: options.next ?? "",
    contextPaths: options.ref ?? []
  };
}

async function editDraft(draft: SessionDraft, inferred: boolean): Promise<SessionDraft> {
  const goal = await input({ message: "Task goal", default: draft.goal, required: true });
  const acceptance = commaList(await input({
    message: "Acceptance criteria (comma-separated)",
    default: draft.acceptance.join(", ")
  }));
  const completed = commaList(await input({
    message: "Completed work (comma-separated)",
    default: draft.completed.join(", ")
  }));
  const pending = commaList(await input({
    message: "Pending work (comma-separated)",
    default: draft.pending.join(", ")
  }));
  const decisions = commaList(await input({
    message: "Confirmed decisions (comma-separated)",
    default: draft.decisions.join(", ")
  }));
  const blockers = commaList(await input({
    message: "Blockers (comma-separated)",
    default: draft.blockers.join(", ")
  }));
  const nextAction = await input({
    message: "Next action",
    default: draft.nextAction,
    required: true
  });
  const contextPaths = commaList(await input({
    message: "Relevant file paths (comma-separated)",
    default: draft.contextPaths.join(", ")
  }));
  const accepted = await confirm({
    message: inferred
      ? "Save this agent-inferred draft as a checkpoint?"
      : "Save this checkpoint?",
    default: true
  });
  if (!accepted) throw new Error("Checkpoint cancelled");
  return { ...draft, goal, acceptance, completed, pending, decisions, blockers, nextAction, contextPaths };
}

export async function createCheckpointFromOptions(options: CheckpointOptions): Promise<{
  root: string;
  checkpoint: Checkpoint;
  path: string;
}> {
  const { root, config } = openRepository({ quiet: options.quiet });
  const sourceAgent = options.from ?? "manual";
  let sessionId: string | undefined;
  let draft = manualDraft(options);
  const inferred = sourceAgent !== "manual";
  if (sourceAgent !== "manual") {
    const candidate = loadSessionCandidate(sourceAgent, root, options.session ?? "last");
    sessionId = candidate.sessionId;
    draft = options.summarize
      ? summarizeSession(candidate)
      : draftFromSession(candidate, config.maxSessionMessages);
    draft = {
      ...draft,
      goal: options.goal ?? draft.goal,
      acceptance: options.acceptance?.length ? options.acceptance : draft.acceptance,
      completed: options.completed?.length ? options.completed : draft.completed,
      pending: options.pending?.length ? options.pending : draft.pending,
      decisions: options.decision?.length ? options.decision : draft.decisions,
      attempts: options.attempt?.length
        ? options.attempt.map((value) => {
          const [approach, ...reason] = value.split("::");
          return { approach: approach || value, reason: reason.join("::") || "No reason recorded" };
        })
        : draft.attempts,
      blockers: options.blocker?.length ? options.blocker : draft.blockers,
      nextAction: options.next ?? draft.nextAction,
      contextPaths: options.ref?.length ? options.ref : draft.contextPaths
    };
  } else if ((options.ref ?? []).length === 0) {
    draft = {
      ...draft,
      contextPaths: suggestContextPaths(root, options.ref ?? [])
    };
  }
  if (!options.yes) {
    if (!process.stdin.isTTY) throw new Error("Interactive confirmation requires a TTY; pass --yes with explicit values");
    draft = await editDraft(draft, inferred);
  }
  if (!draft.goal.trim()) throw new Error("Task goal is required");
  if (!draft.nextAction.trim()) {
    draft = { ...draft, nextAction: draft.goal };
  }
  const taskId = safeId(options.task ?? fallbackTaskId(draft.goal));
  const revision = nextRevision(root, taskId);
  const provenance = inferred ? "agent-inferred" : "user-stated";
  const contextRefs = draft.contextPaths.map((path) => ({
    path,
    symbols: [],
    reason: inferred
      ? "Extracted from source session"
      : options.ref && options.ref.length > 0
        ? "Provided during checkpoint"
        : "Auto-captured from working tree"
  }));
  const repository = collectRepositoryState(root, contextRefs);
  const refsWithHashes = contextRefs.map((ref) => ({ ...ref, hash: repository.fileHashes[ref.path] }));
  const now = new Date().toISOString();
  const checkpoint: Checkpoint = {
    schemaVersion: SCHEMA_VERSION,
    id: `${taskId}-r${revision}`,
    taskId,
    revision,
    createdAt: now,
    source: { agent: sourceAgent, sessionId, cwd: root },
    task: {
      goal: sourced(draft.goal, provenance),
      acceptance: draft.acceptance.map((item) => sourced(item, provenance)),
      status: options.status ?? (draft.blockers.length > 0 ? "blocked" : "active")
    },
    progress: {
      completed: draft.completed.map((item) => sourced(item, provenance)),
      pending: draft.pending.map((item) => sourced(item, provenance))
    },
    decisions: draft.decisions.map((item) => sourced(item, provenance)),
    attempts: draft.attempts.map((attempt) => ({
      approach: sourced(attempt.approach, provenance),
      result: "failed",
      reason: sourced(attempt.reason, provenance)
    })),
    blockers: draft.blockers.map((item) => sourced(item, provenance)),
    nextAction: sourced(draft.nextAction, provenance),
    repository,
    verification: options.verifyCommand ? [{
      command: options.verifyCommand,
      exitCode: Number.parseInt(options.verifyExit ?? "0", 10),
      recordedAt: now,
      outputSummary: options.verifySummary ?? "Recorded by user",
      provenance: "user-stated"
    }] : [],
    contextRefs: refsWithHashes,
    capabilities: { requiredTools: [], requiredPermissions: [] },
    freshness: { checkedAt: now, stale: false, reasons: [] }
  };
  assertNoSecrets(checkpoint);
  const path = saveCheckpoint(root, checkpoint);
  if (!options.quiet) console.log(`Saved ${checkpointLabel(checkpoint)}\n${path}`);
  return { root, checkpoint, path };
}

export async function resumeCheckpoint(
  root: string,
  checkpoint: Checkpoint,
  target: HandoffTarget,
  options: {
    copy?: boolean;
    exec?: boolean;
    output?: string;
    print?: boolean;
    sessionName?: string;
    tolerateCopyFailure?: boolean;
    launchMode?: LaunchMode;
    cliPath: string;
  }
): Promise<ResumeResult> {
  const freshness = verifyRepositoryState(checkpoint.repository, root);
  const current: Checkpoint = {
    ...checkpoint,
    freshness: {
      checkedAt: new Date().toISOString(),
      stale: freshness.stale,
      reasons: freshness.reasons
    }
  };
  const targetSessionName = target !== "human" && supportsNativeEnter(target)
    ? options.sessionName ?? checkpoint.taskId
    : options.sessionName;
  const prompt = target === "human"
    ? renderHumanHandoff(current)
    : renderHandoffPrompt(current, target, { sessionName: targetSessionName });
  assertNoSecrets(prompt);
  const outputPath = options.output === undefined && !options.exec
    ? undefined
    : saveRenderedHandoff(root, checkpoint, target, prompt, options.output || undefined);
  if (options.print !== false) console.log(prompt);
  let copied = false;
  let copyError: string | undefined;
  if (options.copy) {
    try {
      await clipboard.write(prompt);
      copied = true;
      if (options.print !== false) console.log("\nPrompt copied to clipboard.");
    } catch (error) {
      copyError = error instanceof Error ? error.message : String(error);
      if (!options.tolerateCopyFailure) throw error;
    }
  }
  let launched = false;
  let launchMode: ResolvedLaunchMode | undefined;
  let targetSessionId: string | undefined;
  let launchReceiptPath: string | undefined;
  let resumeCommand: string | undefined;
  if (options.exec) {
    if (target === "human") throw new Error("Cannot --exec a human handoff; use --copy or export Markdown");
    if (target === "claude") {
      targetSessionId = randomUUID();
    } else if (target === "codex") {
      targetSessionId = targetSessionName ?? "__last__";
    } else if (target === "opencode" || target === "cursor" || target === "copilot") {
      // These CLIs assign or keep session identity themselves; resume via receipt + weak enter.
      targetSessionId = "__last__";
    }
    const spec = launchSpec(target, root, prompt, {
      sessionId: targetSessionId,
      sessionName: targetSessionName
    });
    if (!commandExists(spec.command)) {
      throw new Error(`${spec.command} is not installed; the prompt above is still usable`);
    }
    launchMode = resolveLaunchMode(options.launchMode ?? "auto");
    // Save the launch receipt BEFORE spawning so it persists
    // even when the interactive child runs long (e.g. Claude Code).
    if (supportsNativeEnter(target) && targetSessionId && outputPath) {
      launchReceiptPath = saveLaunchReceipt(root, {
        version: 1,
        taskId: checkpoint.taskId,
        revision: checkpoint.revision,
        target,
        sessionId: targetSessionId,
        sessionName: targetSessionName,
        repositoryRoot: root,
        promptPath: outputPath,
        createdAt: new Date().toISOString()
      });
      resumeCommand = target === "claude"
        ? `claude --resume ${targetSessionId}`
        : target === "opencode"
          ? "opencode --continue"
          : target === "cursor"
            ? "agent resume"
            : target === "copilot"
              ? `handoff enter ${checkpoint.taskId} --to copilot`
              : targetSessionId === "__last__"
                ? "codex resume --last"
                : `codex resume ${targetSessionId}`;
      if (enterMode(target) === "weak" && options.print !== false) {
        console.log(`Note: ${target} re-entry is weak (no portable session export). Use: handoff enter ${checkpoint.taskId} --to ${target}`);
      }
    }
    if (launchMode === "terminal") {
      if (!outputPath) throw new Error("A saved prompt is required for terminal launch mode");
      spawnInVisibleTerminal(process.execPath, [
        options.cliPath,
        "_launch",
        outputPath,
        "--to",
        target,
        ...(target === "claude" && targetSessionId ? ["--session-id", targetSessionId] : []),
        ...(targetSessionName ? ["--name", targetSessionName] : [])
      ], root);
    } else {
      const exitCode = await spawnInteractive(spec.command, spec.args, spec.cwd);
      if (exitCode !== 0) throw new Error(`${spec.command} exited with ${exitCode}`);
    }
    launched = true;
  }
  return {
    freshness: freshness.stale ? "STALE" : "FRESH",
    reasons: freshness.reasons,
    prompt,
    outputPath,
    copied,
    copyError,
    launched,
    launchMode,
    targetSessionId,
    targetSessionName,
    launchReceiptPath,
    resumeCommand
  };
}

export function showCheckpoint(checkpoint: Checkpoint): void {
  console.log(`${checkpointLabel(checkpoint)}\n`);
  console.log(`Goal: ${checkpoint.task.goal.text}`);
  console.log(`Status: ${checkpoint.task.status}`);
  console.log(`Next: ${checkpoint.nextAction.text}`);
  console.log(`Source: ${checkpoint.source.agent}${checkpoint.source.sessionId ? ` (${checkpoint.source.sessionId})` : ""}`);
  console.log(`Repository: ${checkpoint.repository.branch}@${checkpoint.repository.head.slice(0, 12)}${checkpoint.repository.dirty ? " dirty" : " clean"}`);
  console.log(`Changed files: ${checkpoint.repository.changedFiles.length}`);
}

export function runDoctor(options: { json?: boolean } = {}): void {
  const root = findRepositoryRoot();
  const initialized = isInitialized(root);
  let latestTask: string | undefined;
  let defaultAgent = "codex";
  if (initialized) {
    const config = loadConfig(root);
    defaultAgent = config.defaultAgent;
    try {
      latestTask = loadCheckpoint(root).taskId;
    } catch {
      // An initialized repository may not have a checkpoint yet.
    }
  }
  const repository = collectRepositoryState(root);
  const agents = {
    codex: commandExists("codex"),
    claude: commandExists("claude"),
    opencode: commandExists("opencode"),
    copilot: commandExists("copilot"),
    cursor: commandExists("agent")
  };
  const handoffCommand = commandExists("handoff");
  const nextSteps = doctorNextSteps({
    initialized,
    handoffCommand,
    latestTask,
    unborn: repository.head === "UNBORN",
    agents,
    defaultAgent
  });
  const result = {
    ok: initialized && handoffCommand,
    repositoryRoot: root,
    initialized,
    handoffCommand,
    head: repository.head,
    unborn: repository.head === "UNBORN",
    defaultAgent,
    agents,
    latestTask,
    nextSteps
  };
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`TaskHandoff: ${result.ok ? "ready" : "needs setup"}`);
    console.log(`Repository: ${root}`);
    console.log(`Initialized: ${initialized}`);
    console.log(`HEAD: ${repository.head}`);
    console.log(`Latest task: ${latestTask ?? "none"}`);
    console.log(`Agents: ${Object.entries(agents).filter(([, ready]) => ready).map(([name]) => name).join(", ") || "none"}`);
    if (nextSteps.length > 0) {
      console.log("Next steps:");
      for (const step of nextSteps) console.log(`- ${step}`);
    }
  }
  if (!result.ok) process.exitCode = 2;
}
