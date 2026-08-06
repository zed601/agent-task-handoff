import { z } from "zod";

export const SCHEMA_VERSION = "1.0.0" as const;

export const provenanceKindSchema = z.enum([
  "observed",
  "user-stated",
  "agent-inferred"
]);

export const sourcedTextSchema = z.object({
  text: z.string().min(1),
  provenance: provenanceKindSchema,
  evidence: z.array(z.string()).default([])
});

export const repositorySchema = z.object({
  root: z.string().min(1),
  branch: z.string(),
  head: z.string(),
  dirty: z.boolean(),
  statusHash: z.string(),
  changedFiles: z.array(z.string()),
  diffStat: z.string(),
  fileHashes: z.record(z.string(), z.string())
});

export const verificationSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  recordedAt: z.string().datetime(),
  outputSummary: z.string(),
  provenance: provenanceKindSchema.default("user-stated")
});

export const contextRefSchema = z.object({
  path: z.string().min(1),
  symbols: z.array(z.string()).default([]),
  reason: z.string().default(""),
  hash: z.string().optional()
});

export const checkpointSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  taskId: z.string().min(1),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  source: z.object({
    agent: z.enum(["manual", "claude", "codex", "opencode", "copilot", "cursor", "import"]),
    sessionId: z.string().optional(),
    cwd: z.string().min(1)
  }),
  task: z.object({
    goal: sourcedTextSchema,
    acceptance: z.array(sourcedTextSchema),
    status: z.enum(["active", "blocked", "done"])
  }),
  progress: z.object({
    completed: z.array(sourcedTextSchema),
    pending: z.array(sourcedTextSchema)
  }),
  decisions: z.array(sourcedTextSchema),
  attempts: z.array(z.object({
    approach: sourcedTextSchema,
    result: z.enum(["failed", "rejected", "partial"]),
    reason: sourcedTextSchema
  })),
  blockers: z.array(sourcedTextSchema),
  nextAction: sourcedTextSchema,
  repository: repositorySchema,
  verification: z.array(verificationSchema),
  contextRefs: z.array(contextRefSchema),
  capabilities: z.object({
    requiredTools: z.array(z.string()),
    requiredPermissions: z.array(z.string())
  }),
  freshness: z.object({
    checkedAt: z.string().datetime(),
    stale: z.boolean(),
    reasons: z.array(z.string())
  })
});

export type ProvenanceKind = z.infer<typeof provenanceKindSchema>;
export type SourcedText = z.infer<typeof sourcedTextSchema>;
export type RepositoryState = z.infer<typeof repositorySchema>;
export type Verification = z.infer<typeof verificationSchema>;
export type ContextRef = z.infer<typeof contextRefSchema>;
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const configSchema = z.object({
  version: z.literal(1),
  defaultAgent: z.enum(["codex", "claude", "opencode", "copilot", "cursor"]).default("codex"),
  defaultExec: z.boolean().default(false),
  secretScan: z.boolean().default(true),
  /**
   * Substrings that suppress high-entropy findings only.
   * Known credential patterns are never allowlisted.
   */
  secretAllowlist: z.array(z.string().min(1)).default([]),
  maxSessionMessages: z.number().int().positive().max(500).default(80)
});

export type HandoffConfig = z.infer<typeof configSchema>;

export const workflowStepSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  instruction: z.string().min(1),
  acceptance: z.array(z.string()).default([]),
  checkpoint: z.string().optional(),
  status: z.enum(["pending", "active", "blocked", "done"]).default("pending")
});

export const workflowSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  currentIndex: z.number().int().nonnegative().default(0),
  status: z.enum(["running", "blocked", "done"]).default("running"),
  blockedReason: z.string().optional(),
  steps: z.array(workflowStepSchema).min(1)
});

export type Workflow = z.infer<typeof workflowSchema>;
