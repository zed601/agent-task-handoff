import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeHandoff } from "../src/store.js";
import { advanceWorkflow, createWorkflow, currentWorkflowStep } from "../src/workflow.js";
import { initializeGitRepository } from "./helpers.js";

describe("linear workflows", () => {
  it("advances one step at a time and completes", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-workflow-"));
    initializeGitRepository(root);
    initializeHandoff(root);
    const workflow = createWorkflow(root, "feature", [
      { id: "implement", role: "developer", instruction: "Implement" },
      { id: "verify", role: "reviewer", instruction: "Verify" }
    ]);
    expect(currentWorkflowStep(workflow)?.id).toBe("implement");
    const next = advanceWorkflow(root, "feature", "done", "feature-r1");
    expect(currentWorkflowStep(next)?.id).toBe("verify");
    expect(advanceWorkflow(root, "feature", "done").status).toBe("done");
  });

  it("records a blocking reason without advancing", () => {
    const root = mkdtempSync(join(tmpdir(), "handoff-workflow-"));
    initializeGitRepository(root);
    initializeHandoff(root);
    createWorkflow(root, "blocked", [{ id: "one", role: "agent", instruction: "Work" }]);
    const result = advanceWorkflow(root, "blocked", "blocked", undefined, "Needs approval");
    expect(result.status).toBe("blocked");
    expect(result.blockedReason).toBe("Needs approval");
  });
});
