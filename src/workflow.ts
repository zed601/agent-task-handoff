import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { type Workflow, workflowSchema } from "./schema.js";
import { handoffPath, safeId } from "./store.js";

function pathFor(repositoryRoot: string, name: string): string {
  return join(handoffPath(repositoryRoot), "workflows", `${safeId(name)}.yaml`);
}

function writeWorkflow(path: string, workflow: Workflow): void {
  writeFileSync(path, YAML.stringify(workflow), { encoding: "utf8", mode: 0o600 });
}

export function createWorkflow(
  repositoryRoot: string,
  name: string,
  steps: Array<{ id: string; role: string; instruction: string; acceptance?: string[] }>
): Workflow {
  const path = pathFor(repositoryRoot, name);
  if (existsSync(path)) throw new Error(`Workflow already exists: ${name}`);
  const workflow = workflowSchema.parse({
    version: 1,
    name,
    currentIndex: 0,
    status: "running",
    steps: steps.map((step, index) => ({
      ...step,
      acceptance: step.acceptance ?? [],
      status: index === 0 ? "active" : "pending"
    }))
  });
  writeWorkflow(path, workflow);
  return workflow;
}

export function loadWorkflow(repositoryRoot: string, name: string): Workflow {
  const path = pathFor(repositoryRoot, name);
  if (!existsSync(path)) throw new Error(`Workflow not found: ${name}`);
  return workflowSchema.parse(YAML.parse(readFileSync(path, "utf8")));
}

export function currentWorkflowStep(workflow: Workflow) {
  return workflow.steps[workflow.currentIndex];
}

export function advanceWorkflow(
  repositoryRoot: string,
  name: string,
  outcome: "done" | "blocked",
  checkpoint?: string,
  reason?: string
): Workflow {
  const workflow = loadWorkflow(repositoryRoot, name);
  if (workflow.status === "done") throw new Error("Workflow is already done");
  const current = workflow.steps[workflow.currentIndex];
  if (!current) throw new Error("Workflow has no active step");
  if (outcome === "blocked") {
    current.status = "blocked";
    workflow.status = "blocked";
    workflow.blockedReason = reason || "No reason provided";
  } else {
    current.status = "done";
    if (checkpoint) current.checkpoint = checkpoint;
    const nextIndex = workflow.currentIndex + 1;
    if (nextIndex >= workflow.steps.length) {
      workflow.status = "done";
    } else {
      workflow.currentIndex = nextIndex;
      workflow.status = "running";
      delete workflow.blockedReason;
      workflow.steps[nextIndex]!.status = "active";
    }
  }
  const parsed = workflowSchema.parse(workflow);
  writeWorkflow(pathFor(repositoryRoot, name), parsed);
  return parsed;
}
