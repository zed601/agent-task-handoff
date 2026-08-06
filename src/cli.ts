#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { input } from "@inquirer/prompts";
import { Command, Option } from "commander";
import YAML from "yaml";
import { findRepositoryRoot, verifyRepositoryState } from "./git.js";
import {
  commandExists,
  LAUNCH_MODES,
  resolveLaunchMode,
  spawnInVisibleTerminal,
  spawnInteractive,
  type LaunchMode
} from "./process.js";
import {
  launchSpec,
  renderHumanHandoff,
  resumeLaunchSpec,
  supportsNativeEnter,
  enterMode,
  TARGET_AGENTS,
  type TargetAgent
} from "./render.js";
import { type Checkpoint } from "./schema.js";
import { assertNoSecrets } from "./security.js";
import { resolveOpenCodeResumeSessionId, type SessionAgent } from "./session.js";
import {
  checkpointLabel,
  exportCheckpoint,
  importCheckpoint,
  initializeHandoff,
  loadCheckpoint,
  loadLaunchReceipt
} from "./store.js";
import {
  advanceWorkflow,
  createWorkflow,
  currentWorkflowStep,
  loadWorkflow
} from "./workflow.js";
import {
  collect,
  createCheckpointFromOptions,
  openRepository,
  printTransferReceipt,
  resolveShouldExec,
  resolveTargetAgent,
  resumeCheckpoint,
  runDoctor,
  showCheckpoint,
  type CheckpointOptions
} from "./ops.js";

const program = new Command();
const CLI_PATH = fileURLToPath(import.meta.url);

function commaList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
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
      launchMode: options.launchMode,
      cliPath: CLI_PATH
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
      launchMode: options.launchMode,
      cliPath: CLI_PATH
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
      launchMode: options.launchMode,
      cliPath: CLI_PATH
    });
    printTransferReceipt(checkpoint, target, result, options.json === true);
  });

program.command("enter")
  .alias("reopen")
  .description("Re-enter the latest launched agent session (Claude/Codex/OpenCode native; Copilot/Cursor weak)")
  .argument("[task]")
  .option("--to <agent>", "target agent that was previously launched")
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
    const sessionId = target === "opencode"
      ? resolveOpenCodeResumeSessionId(receipt.repositoryRoot, receipt.sessionId, {
        sessionName: receipt.sessionName,
        launchedAt: receipt.createdAt
      })
      : receipt.sessionId;
    const prompt = target === "copilot"
      ? readFileSync(receipt.promptPath, "utf8")
      : undefined;
    if (prompt) assertNoSecrets(prompt);
    const spec = resumeLaunchSpec(target, receipt.repositoryRoot, sessionId, { prompt });
    if (!commandExists(spec.command)) throw new Error(`${spec.command} is not installed`);
    const launchMode = resolveLaunchMode(options.launchMode);
    const result = {
      taskId: receipt.taskId,
      target,
      sessionId,
      sessionName: receipt.sessionName,
      launchMode,
      enterMode: enterMode(target)
    };
    if (!options.json) {
      const modeNote = enterMode(target) === "weak" ? " (weak re-entry)" : "";
      console.log(`Re-entering ${receipt.sessionName ?? sessionId} (${sessionId}) in ${launchMode} mode${modeNote}.`);
    }
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
      launchMode: options.launchMode,
      cliPath: CLI_PATH
    });
  });

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
