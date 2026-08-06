#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, input } from "@inquirer/prompts";
import clipboard from "clipboardy";
import { Command, Option } from "commander";
import YAML from "yaml";
import { collectRepositoryState, findRepositoryRoot, verifyRepositoryState } from "./git.js";
import {
  commandExists,
  LAUNCH_MODES,
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
  resumeLaunchSpec,
  supportsNativeEnter,
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
  exportCheckpoint,
  importCheckpoint,
  initializeHandoff,
  isInitialized,
  loadCheckpoint,
  loadConfig,
  loadLaunchReceipt,
  nextRevision,
  safeId,
  saveCheckpoint,
  saveLaunchReceipt,
  saveRenderedHandoff
} from "./store.js";
import {
  advanceWorkflow,
  createWorkflow,
  currentWorkflowStep,
  loadWorkflow
} from "./workflow.js";

const program = new Command();
const CLI_PATH = fileURLToPath(import.meta.url);

interface CheckpointOptions {
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

function collect(value: string, previous: string[]): string[] {
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

function openRepository(options: { quiet?: boolean } = {}): {
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

function agentBinary(target: TargetAgent): string {
  return launchSpec(target, process.cwd(), "probe").command;
}

function installedTargetAgents(): TargetAgent[] {
  return TARGET_AGENTS.filter((agent) => commandExists(agentBinary(agent)));
}

function resolveTargetAgent(
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

function suggestContextPaths(root: string, explicit: string[] = [], limit = 20): string[] {
  if (explicit.length > 0) return explicit;
  return collectRepositoryState(root).changedFiles
    .filter((path) => !path.startsWith(".handoff/") && path !== ".gitignore")
    .slice(0, limit);
}

function resolveShouldExec(
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

function printTransferReceipt(
  checkpoint: Checkpoint,
  target: HandoffTarget,
  result: Awaited<ReturnType<typeof resumeCheckpoint>>,
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

function doctorNextSteps(input: {
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
    if (preferred === "claude" || preferred === "codex") {
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

async function createCheckpointFromOptions(options: CheckpointOptions): Promise<{
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
      acceptance: options.acceptance ?? draft.acceptance,
      completed: options.completed ?? draft.completed,
      pending: options.pending ?? draft.pending,
      decisions: options.decision ?? draft.decisions,
      blockers: options.blocker ?? draft.blockers,
      nextAction: options.next ?? draft.nextAction,
      contextPaths: options.ref ?? draft.contextPaths
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

async function resumeCheckpoint(
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
  }
): Promise<{
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
}> {
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
        : targetSessionId === "__last__"
          ? "codex resume --last"
          : `codex resume ${targetSessionId}`;
    }
    if (launchMode === "terminal") {
      if (!outputPath) throw new Error("A saved prompt is required for terminal launch mode");
      spawnInVisibleTerminal(process.execPath, [
        CLI_PATH,
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

function showCheckpoint(checkpoint: Checkpoint): void {
  console.log(`${checkpointLabel(checkpoint)}\n`);
  console.log(`Goal: ${checkpoint.task.goal.text}`);
  console.log(`Status: ${checkpoint.task.status}`);
  console.log(`Next: ${checkpoint.nextAction.text}`);
  console.log(`Source: ${checkpoint.source.agent}${checkpoint.source.sessionId ? ` (${checkpoint.source.sessionId})` : ""}`);
  console.log(`Repository: ${checkpoint.repository.branch}@${checkpoint.repository.head.slice(0, 12)}${checkpoint.repository.dirty ? " dirty" : " clean"}`);
  console.log(`Changed files: ${checkpoint.repository.changedFiles.length}`);
}

program
  .name("handoff")
  .description("Verifiable task handoff between coding agents")
  .version("0.8.0")
  .showHelpAfterError();

program.command("_launch", { hidden: true })
  .description("Internal target-agent launcher")
  .argument("<prompt-file>")
  .requiredOption("--to <agent>")
  .option("--session-id <uuid>")
  .option("--name <session-name>")
  .action(async (promptFile: string, options: {
    to: TargetAgent;
    sessionId?: string;
    name?: string;
  }) => {
    if (!TARGET_AGENTS.includes(options.to)) throw new Error(`Unsupported agent: ${options.to}`);
    const root = findRepositoryRoot();
    const prompt = readFileSync(resolve(promptFile), "utf8");
    assertNoSecrets(prompt);
    const spec = launchSpec(options.to, root, prompt, {
      sessionId: options.sessionId,
      sessionName: options.name
    });
    if (!commandExists(spec.command)) throw new Error(`${spec.command} is not installed`);
    const exitCode = await spawnInteractive(spec.command, spec.args, spec.cwd);
    if (exitCode !== 0) process.exitCode = exitCode;
  });

program.command("init")
  .description("Initialize TaskHandoff in the current Git repository")
  .action(() => {
    const root = findRepositoryRoot();
    initializeHandoff(root);
    console.log(`Initialized ${resolve(root, ".handoff")}`);
  });

program.command("checkpoint")
  .description("Create an immutable task checkpoint")
  .option("--task <id>", "task identifier")
  .addOption(new Option("--from <agent>", "source session").choices(["manual", "claude", "codex", "opencode"]).default("manual"))
  .option("--session <id>", "session id or last", "last")
  .option("--summarize", "use the source agent CLI for structured summarization")
  .option("--yes", "save without interactive confirmation")
  .option("--goal <text>", "task goal")
  .option("--acceptance <item>", "acceptance criterion", collect, [])
  .option("--completed <item>", "completed item", collect, [])
  .option("--pending <item>", "pending item", collect, [])
  .option("--decision <item>", "confirmed decision", collect, [])
  .option("--attempt <approach::reason>", "failed attempt", collect, [])
  .option("--blocker <item>", "blocker", collect, [])
  .option("--next <text>", "next action")
  .option("--ref <path>", "relevant file path", collect, [])
  .addOption(new Option("--status <status>").choices(["active", "blocked", "done"]))
  .option("--verify-command <command>", "recorded verification command")
  .option("--verify-exit <code>", "recorded verification exit code")
  .option("--verify-summary <text>", "recorded verification summary")
  .action(async (options: CheckpointOptions) => {
    await createCheckpointFromOptions(options);
  });

program.command("inspect")
  .description("Inspect the latest checkpoint for a task")
  .argument("[task]")
  .option("--json", "print machine-readable JSON")
  .action((task: string | undefined, options: { json?: boolean }) => {
    const { root } = openRepository({ quiet: true });
    const checkpoint = loadCheckpoint(root, task);
    if (options.json) console.log(JSON.stringify(checkpoint, null, 2));
    else showCheckpoint(checkpoint);
  });

program.command("verify")
  .description("Verify whether checkpoint evidence is still fresh")
  .argument("[task]")
  .option("--json", "print machine-readable JSON")
  .action((task: string | undefined, options: { json?: boolean }) => {
    const { root } = openRepository({ quiet: true });
    const checkpoint = loadCheckpoint(root, task);
    const result = verifyRepositoryState(checkpoint.repository, root);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else if (result.stale) console.log(`STALE\n${result.reasons.map((reason) => `- ${reason}`).join("\n")}`);
    else console.log("FRESH\nRepository evidence still matches the checkpoint.");
    if (result.stale) process.exitCode = 2;
  });

program.command("resume")
  .description("Render or launch a target agent with a checkpoint")
  .argument("[task]")
  .option("--to <agent>", "codex, claude, opencode, copilot, cursor, or human")
  .option("--copy", "copy the prompt to the clipboard")
  .option("--exec", "launch the target agent")
  .option("--no-exec", "do not launch the target agent")
  .addOption(new Option("--launch-mode <mode>", "auto, inline, or terminal").choices(LAUNCH_MODES).default("auto"))
  .option("--name <session-name>", "exact target session name")
  .option("-o, --output <path>", "also save the rendered prompt")
  .action(async (task: string | undefined, options: {
    to?: string;
    copy?: boolean;
    exec?: boolean;
    noExec?: boolean;
    launchMode: LaunchMode;
    name?: string;
    output?: string;
  }) => {
    const { root, config } = openRepository({ quiet: true });
    const target = resolveTargetAgent(options.to, config);
    await resumeCheckpoint(root, loadCheckpoint(root, task), target, {
      copy: options.copy,
      exec: resolveShouldExec(options, config, target, false),
      output: options.output,
      print: true,
      sessionName: options.name,
      launchMode: options.launchMode
    });
  });

program.command("transfer")
  .alias("send")
  .description("Verify and deliver a compact handoff in one command")
  .argument("[task]")
  .option("--to <agent>", "codex, claude, opencode, copilot, cursor, or human")
  .option("--name <session-name>", "exact target session name")
  .option("--exec", "launch the target agent")
  .option("--no-exec", "do not launch even when defaultExec is enabled")
  .addOption(new Option("--launch-mode <mode>", "auto, inline, or terminal").choices(LAUNCH_MODES).default("auto"))
  .option("--no-copy", "do not copy the prompt to the clipboard")
  .option("--print", "also print the full prompt")
  .option("-o, --output <path>", "save path (defaults to .handoff/exports)")
  .option("--json", "print a machine-readable receipt")
  .action(async (task: string | undefined, options: {
    to?: string;
    name?: string;
    exec?: boolean;
    noExec?: boolean;
    launchMode: LaunchMode;
    copy: boolean;
    print?: boolean;
    output?: string;
    json?: boolean;
  }) => {
    const { root, config } = openRepository({ quiet: true });
    const target = resolveTargetAgent(options.to, config);
    const checkpoint = loadCheckpoint(root, task);
    const result = await resumeCheckpoint(root, checkpoint, target, {
      copy: options.copy,
      exec: resolveShouldExec(options, config, target, false),
      output: options.output ?? "",
      print: options.print === true,
      sessionName: options.name,
      tolerateCopyFailure: true,
      launchMode: options.launchMode
    });
    printTransferReceipt(checkpoint, target, result, options.json === true);
  });

program.command("snap")
  .alias("save")
  .description("Quick checkpoint from a goal and current Git changes")
  .option("--task <id>", "task identifier")
  .option("--goal <text>", "task goal")
  .option("--next <text>", "next action (defaults to the goal)")
  .option("--acceptance <item>", "acceptance criterion", collect, [])
  .option("--completed <item>", "completed item", collect, [])
  .option("--pending <item>", "pending item", collect, [])
  .option("--decision <item>", "confirmed decision", collect, [])
  .option("--attempt <approach::reason>", "failed attempt", collect, [])
  .option("--blocker <item>", "blocker", collect, [])
  .option("--ref <path>", "relevant file path (defaults to dirty files)", collect, [])
  .option("--yes", "save without interactive confirmation")
  .option("--json", "print a machine-readable receipt")
  .action(async (options: {
    task?: string;
    goal?: string;
    next?: string;
    acceptance: string[];
    completed: string[];
    pending: string[];
    decision: string[];
    attempt: string[];
    blocker: string[];
    ref: string[];
    yes?: boolean;
    json?: boolean;
  }) => {
    if (!options.goal?.trim() && (options.yes || options.json || !process.stdin.isTTY)) {
      throw new Error('Provide --goal "what you are doing"');
    }
    const result = await createCheckpointFromOptions({
      task: options.task,
      from: "manual",
      yes: options.yes ?? Boolean(options.goal?.trim()),
      quiet: options.json === true,
      goal: options.goal,
      next: options.next,
      acceptance: options.acceptance,
      completed: options.completed,
      pending: options.pending,
      decision: options.decision,
      attempt: options.attempt,
      blocker: options.blocker,
      ref: options.ref
    });
    if (options.json) {
      console.log(JSON.stringify({
        taskId: result.checkpoint.taskId,
        revision: result.checkpoint.revision,
        goal: result.checkpoint.task.goal.text,
        nextAction: result.checkpoint.nextAction.text,
        refs: result.checkpoint.contextRefs.map((ref) => ref.path),
        path: result.path,
        next: `handoff go ${result.checkpoint.taskId}`
      }, null, 2));
      return;
    }
    console.log(`Next: handoff go ${result.checkpoint.taskId}`);
  });

program.command("go")
  .description("One-command handoff: checkpoint if needed, then transfer")
  .argument("[task]")
  .option("--to <agent>", "target agent (auto-detected when omitted)")
  .addOption(new Option("--from <agent>", "create from a source session").choices(["claude", "codex", "opencode"]))
  .option("--session <id>", "source session id or last", "last")
  .option("--summarize", "use the source agent CLI for structured summarization")
  .option("--task <id>", "task identifier when creating a checkpoint")
  .option("--goal <text>", "task goal when creating a checkpoint")
  .option("--next <text>", "next action when creating a checkpoint")
  .option("--acceptance <item>", "acceptance criterion", collect, [])
  .option("--completed <item>", "completed item", collect, [])
  .option("--pending <item>", "pending item", collect, [])
  .option("--decision <item>", "confirmed decision", collect, [])
  .option("--attempt <approach::reason>", "failed attempt", collect, [])
  .option("--blocker <item>", "blocker", collect, [])
  .option("--ref <path>", "relevant file path (defaults to dirty files)", collect, [])
  .option("--name <session-name>", "exact target session name")
  .option("--exec", "launch the target agent (default when its CLI is installed)")
  .option("--no-exec", "copy/render only; do not launch")
  .addOption(new Option("--launch-mode <mode>", "auto, inline, or terminal").choices(LAUNCH_MODES).default("auto"))
  .option("--no-copy", "do not copy the prompt to the clipboard")
  .option("--print", "also print the full prompt")
  .option("--yes", "save without interactive confirmation when creating a checkpoint")
  .option("--json", "print a machine-readable receipt")
  .action(async (taskArg: string | undefined, options: {
    to?: string;
    from?: SessionAgent;
    session?: string;
    summarize?: boolean;
    task?: string;
    goal?: string;
    next?: string;
    acceptance: string[];
    completed: string[];
    pending: string[];
    decision: string[];
    attempt: string[];
    blocker: string[];
    ref: string[];
    name?: string;
    exec?: boolean;
    noExec?: boolean;
    launchMode: LaunchMode;
    copy: boolean;
    print?: boolean;
    yes?: boolean;
    json?: boolean;
  }) => {
    const { root, config } = openRepository({ quiet: options.json === true });
    const target = resolveTargetAgent(options.to, config);
    const creating = Boolean(
      options.from ||
      options.goal ||
      options.next ||
      options.task ||
      options.acceptance.length ||
      options.completed.length ||
      options.pending.length ||
      options.decision.length ||
      options.attempt.length ||
      options.blocker.length ||
      options.ref.length
    );

    let checkpoint: Checkpoint;
    if (creating) {
      if (options.from) {
        const created = await createCheckpointFromOptions({
          task: options.task ?? taskArg,
          from: options.from,
          session: options.session,
          summarize: options.summarize,
          yes: options.yes ?? true,
          quiet: options.json === true,
          goal: options.goal,
          next: options.next,
          acceptance: options.acceptance,
          completed: options.completed,
          pending: options.pending,
          decision: options.decision,
          attempt: options.attempt,
          blocker: options.blocker,
          ref: options.ref
        });
        checkpoint = created.checkpoint;
      } else {
        if (!options.goal?.trim()) throw new Error('Provide --goal "what you are doing" when creating with handoff go');
        const created = await createCheckpointFromOptions({
          task: options.task ?? taskArg,
          from: "manual",
          yes: options.yes ?? true,
          quiet: options.json === true,
          goal: options.goal,
          next: options.next ?? options.goal,
          acceptance: options.acceptance,
          completed: options.completed,
          pending: options.pending,
          decision: options.decision,
          attempt: options.attempt,
          blocker: options.blocker,
          ref: options.ref
        });
        checkpoint = created.checkpoint;
      }
    } else {
      checkpoint = loadCheckpoint(root, taskArg ?? options.task);
    }

    const result = await resumeCheckpoint(root, checkpoint, target, {
      copy: options.copy,
      exec: resolveShouldExec(options, config, target, true),
      output: "",
      print: options.print === true,
      sessionName: options.name,
      tolerateCopyFailure: true,
      launchMode: options.launchMode
    });
    printTransferReceipt(checkpoint, target, result, options.json === true);
  });

program.command("enter")
  .alias("reopen")
  .description("Re-enter the latest launched Claude or Codex session")
  .argument("[task]")
  .option("--to <agent>", "target agent; claude and codex are supported")
  .addOption(new Option("--launch-mode <mode>", "auto, inline, or terminal").choices(LAUNCH_MODES).default("auto"))
  .option("--json", "print machine-readable JSON")
  .action(async (task: string | undefined, options: { to?: string; launchMode: LaunchMode; json?: boolean }) => {
    const { root } = openRepository({ quiet: true });
    const receipt = loadLaunchReceipt(root, task, options.to);
    if (!TARGET_AGENTS.includes(receipt.target as TargetAgent)) {
      throw new Error(`Unsupported agent in launch receipt: ${receipt.target}`);
    }
    const target = receipt.target as TargetAgent;
    if (!supportsNativeEnter(target)) {
      throw new Error(`Native session re-entry is not implemented for ${target}`);
    }
    const spec = resumeLaunchSpec(target, receipt.repositoryRoot, receipt.sessionId);
    if (!commandExists(spec.command)) throw new Error(`${spec.command} is not installed`);
    const launchMode = resolveLaunchMode(options.launchMode);
    const result = {
      taskId: receipt.taskId,
      target,
      sessionId: receipt.sessionId,
      sessionName: receipt.sessionName,
      launchMode
    };
    if (!options.json) console.log(`Re-entering ${receipt.sessionName ?? receipt.sessionId} (${receipt.sessionId}) in ${launchMode} mode.`);
    if (launchMode === "terminal") {
      spawnInVisibleTerminal(spec.command, spec.args, spec.cwd);
      if (options.json) console.log(JSON.stringify(result, null, 2));
      return;
    }
    const exitCode = await spawnInteractive(spec.command, spec.args, spec.cwd);
    if (exitCode !== 0) throw new Error(`${spec.command} exited with ${exitCode}`);
    if (options.json) console.log(JSON.stringify(result, null, 2));
  });

program.command("rescue")
  .description("Capture the latest source session and hand it to another agent")
  .option("--to <agent>", "codex, claude, opencode, copilot, cursor, or human")
  .addOption(new Option("--from <agent>", "source agent").choices(["claude", "codex", "opencode"]))
  .option("--task <id>", "task identifier")
  .option("--summarize", "use the source agent CLI for structured summarization")
  .option("--yes", "save without interactive confirmation")
  .option("--copy", "copy the prompt to the clipboard")
  .option("--exec", "launch the target agent")
  .option("--no-exec", "do not launch the target agent")
  .addOption(new Option("--launch-mode <mode>", "auto, inline, or terminal").choices(LAUNCH_MODES).default("auto"))
  .action(async (options: {
    to?: string;
    from?: SessionAgent;
    task?: string;
    summarize?: boolean;
    yes?: boolean;
    copy?: boolean;
    exec?: boolean;
    noExec?: boolean;
    launchMode: LaunchMode;
  }) => {
    const { config } = openRepository({ quiet: true });
    const target = resolveTargetAgent(options.to, config, { allowHumanFallback: false });
    const source = options.from ?? (target === "claude" ? "codex" : "claude");
    const result = await createCheckpointFromOptions({
      task: options.task,
      from: source,
      session: "last",
      summarize: options.summarize,
      yes: options.yes
    });
    await resumeCheckpoint(result.root, result.checkpoint, target, {
      copy: options.copy,
      exec: resolveShouldExec(options, config, target, false),
      launchMode: options.launchMode
    });
  });

function runDoctor(options: { json?: boolean } = {}): void {
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

program.command("doctor", { isDefault: true })
  .description("Check TaskHandoff and agent integration readiness")
  .option("--json", "print machine-readable JSON")
  .action((options: { json?: boolean }) => {
    runDoctor(options);
  });

program.command("export")
  .description("Export a portable, secret-scanned checkpoint")
  .argument("[task]")
  .option("-o, --output <path>", "output path")
  .addOption(new Option("--format <format>").choices(["json", "markdown"]).default("json"))
  .action((task: string | undefined, options: { output?: string; format: "json" | "markdown" }) => {
    const { root } = openRepository({ quiet: true });
    const checkpoint = loadCheckpoint(root, task);
    const content = options.format === "markdown" ? renderHumanHandoff(checkpoint) : undefined;
    console.log(exportCheckpoint(root, checkpoint, options.output, options.format, content));
  });

program.command("import")
  .description("Import a portable checkpoint as a new revision")
  .argument("<path>")
  .action((path: string) => {
    const { root } = openRepository();
    const checkpoint = importCheckpoint(root, path);
    console.log(`Imported ${checkpointLabel(checkpoint)}`);
  });

const workflow = program.command("workflow").description("Manage a linear handoff workflow");

workflow.command("init")
  .description("Create a linear workflow")
  .argument("<name>")
  .option("--file <path>", "YAML file containing a steps array")
  .option("--step <id|role|instruction>", "workflow step", collect, [])
  .action(async (name: string, options: { file?: string; step: string[] }) => {
    const { root } = openRepository();
    let steps: Array<{ id: string; role: string; instruction: string; acceptance?: string[] }>;
    if (options.file) {
      const value = YAML.parse(readFileSync(resolve(options.file), "utf8")) as { steps?: typeof steps } | typeof steps;
      steps = Array.isArray(value) ? value : value.steps ?? [];
    } else {
      let specifications = options.step;
      if (specifications.length === 0) {
        if (!process.stdin.isTTY) throw new Error("Provide --file or at least one --step");
        specifications = commaList(await input({
          message: "Steps as id|role|instruction (comma-separated)",
          default: "implement|implementer|Implement the task,test|reviewer|Run tests and verify acceptance"
        }));
      }
      steps = specifications.map((specification) => {
        const [id, role, ...instruction] = specification.split("|");
        if (!id || !role || instruction.length === 0) throw new Error(`Invalid step: ${specification}`);
        return { id, role, instruction: instruction.join("|") };
      });
    }
    const result = createWorkflow(root, name, steps);
    console.log(YAML.stringify(result));
  });

workflow.command("status")
  .description("Show workflow state")
  .argument("<name>")
  .option("--json")
  .action((name: string, options: { json?: boolean }) => {
    const { root } = openRepository({ quiet: true });
    const value = loadWorkflow(root, name);
    console.log(options.json ? JSON.stringify(value, null, 2) : YAML.stringify(value));
  });

workflow.command("next")
  .description("Show the active workflow step")
  .argument("<name>")
  .action((name: string) => {
    const { root } = openRepository({ quiet: true });
    const value = loadWorkflow(root, name);
    const step = currentWorkflowStep(value);
    if (!step) {
      console.log("Workflow complete.");
      return;
    }
    console.log(`# ${step.id}\nRole: ${step.role}\nStatus: ${step.status}\n\n${step.instruction}\n\nAcceptance:\n${step.acceptance.map((item) => `- ${item}`).join("\n") || "- None"}`);
  });

workflow.command("advance")
  .description("Complete or block the active step")
  .argument("<name>")
  .addOption(new Option("--outcome <outcome>").choices(["done", "blocked"]).makeOptionMandatory())
  .option("--checkpoint <id>", "checkpoint linked to the completed step")
  .option("--reason <text>", "blocking reason")
  .action((name: string, options: { outcome: "done" | "blocked"; checkpoint?: string; reason?: string }) => {
    const { root } = openRepository({ quiet: true });
    console.log(YAML.stringify(advanceWorkflow(root, name, options.outcome, options.checkpoint, options.reason)));
  });

program.configureOutput({
  outputError: (value, write) => write(`Error: ${value}`)
});

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exitCode = 1;
});
