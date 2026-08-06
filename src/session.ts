import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commandExists, runCommand } from "./process.js";
import { scanSecrets } from "./security.js";

export type SessionAgent = "claude" | "codex" | "opencode";

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

export interface SessionCandidate {
  agent: SessionAgent;
  sessionId?: string;
  path: string;
  cwd?: string;
  messages: SessionMessage[];
  commands: string[];
  files: string[];
}

export interface SessionDraft {
  goal: string;
  acceptance: string[];
  completed: string[];
  pending: string[];
  decisions: string[];
  attempts: Array<{ approach: string; reason: string }>;
  blockers: string[];
  nextAction: string;
  contextPaths: string[];
}

export const sessionSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    goal: { type: "string" },
    acceptance: { type: "array", items: { type: "string" } },
    completed: { type: "array", items: { type: "string" } },
    pending: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    attempts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          approach: { type: "string" },
          reason: { type: "string" }
        },
        required: ["approach", "reason"]
      }
    },
    blockers: { type: "array", items: { type: "string" } },
    nextAction: { type: "string" },
    contextPaths: { type: "array", items: { type: "string" } }
  },
  required: [
    "goal",
    "acceptance",
    "completed",
    "pending",
    "decisions",
    "attempts",
    "blockers",
    "nextAction",
    "contextPaths"
  ]
} as const;

const MAX_SESSION_CANDIDATES = 80;

function walk(root: string, files: string[] = []): string[] {
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

function clip(text: string, max = 280): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/gi, " ").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[], limit: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!normalized) continue;
    const key = normalizeKey(normalized);
    if (!key || seen.has(key)) continue;
    // Drop near-duplicates that share a long stem with an earlier hit.
    if ([...seen].some((existing) => {
      if (existing.length < 24 || key.length < 24) return false;
      return existing.includes(key.slice(0, 32)) || key.includes(existing.slice(0, 32));
    })) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function scoreGoalCandidate(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 12 || isAckMessage(trimmed)) return -1;
  let score = Math.min(trimmed.length, 240);
  if (/\b(?:fix|implement|add|build|create|refactor|migrate|debug|investigate|finish|complete|修复|实现|完成|继续)\b/i.test(trimmed)) {
    score += 40;
  }
  if (/\b(?:goal|task|acceptance|验收|目标)\b/i.test(trimmed)) score += 20;
  if (/[\\/][\w.-]+\.[A-Za-z0-9]{1,10}\b/.test(trimmed)) score += 15;
  if (isAckMessage(trimmed) || /^(?:please continue|继续|往下做)/i.test(trimmed)) score -= 30;
  return score;
}

function pickGoal(userMessages: SessionMessage[]): string {
  // Prefer the latest high-signal user turn so early setup chatter does not win.
  let best: { text: string; score: number; index: number } | undefined;
  userMessages.forEach((message, index) => {
    const score = scoreGoalCandidate(message.text);
    if (score < 0) return;
    if (!best || score > best.score || (score === best.score && index > best.index)) {
      best = { text: message.text, score, index };
    }
  });
  return clip(best?.text ?? "Continue the unfinished task from the selected session", 2_000);
}

function dedupeAttempts(
  attempts: Array<{ approach: string; reason: string }>,
  limit: number
): Array<{ approach: string; reason: string }> {
  const approaches = uniqueStrings(attempts.map((item) => item.approach), limit);
  return approaches.map((approach) => {
    const match = attempts.find((item) => normalizeKey(item.approach) === normalizeKey(approach))
      ?? attempts.find((item) => normalizeKey(item.approach).includes(normalizeKey(approach).slice(0, 24)));
    return {
      approach,
      reason: match?.reason ?? "Extracted from visible session text; re-verify before retrying."
    };
  });
}

function firstSentence(text: string, max = 280): string {
  const match = text.match(/[^.!?\n]{8,}[.!?]?/);
  return clip(match?.[0] ?? text, max);
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/^[\s*-]+/, "").trim())
    .filter((part) => part.length >= 8);
}

function collectMatchingSentences(texts: string[], pattern: RegExp, limit: number): string[] {
  const hits: string[] = [];
  for (const text of texts) {
    for (const sentence of sentences(text)) {
      if (pattern.test(sentence)) hits.push(clip(sentence));
      pattern.lastIndex = 0;
    }
  }
  return uniqueStrings(hits, limit);
}

function isAckMessage(text: string): boolean {
  return /^(?:ok(?:ay)?|yes|yep|sure|continue|thanks|thx|got it|继续|好的|行|嗯+|收到)[.!]?$/i.test(text.trim());
}

function parseLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const object = block as Record<string, unknown>;
      if (!["text", "input_text", "output_text"].includes(String(object.type))) return [];
      return typeof object.text === "string" ? [object.text] : [];
    })
    .join("\n");
}

function extractPaths(text: string): string[] {
  const matches = text.match(/(?:^|[\s`'"(])((?:\.?\.?\/)?[\w@.-]+(?:\/[\w@.() -]+)+\.[A-Za-z0-9]{1,10})/gm) ?? [];
  return matches
    .map((match) => match.trim().replace(/^[`'"(]+|[`'")]+$/g, ""))
    .filter((path) => !path.startsWith("http"));
}

function parseClaude(path: string): SessionCandidate {
  const records = parseLines(path) as Array<Record<string, unknown>>;
  const messages: SessionMessage[] = [];
  const commands: string[] = [];
  const files = new Set<string>();
  let cwd: string | undefined;
  let sessionId: string | undefined;
  for (const record of records) {
    if (typeof record.cwd === "string") cwd = record.cwd;
    if (typeof record.sessionId === "string") sessionId = record.sessionId;
    if (record.isSidechain === true) continue;
    if (record.type !== "user" && record.type !== "assistant") continue;
    const message = record.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const text = textFromContent(message.content);
    if (text.trim()) {
      messages.push({ role: record.type, text: text.trim() });
      extractPaths(text).forEach((item) => files.add(item));
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const value = block as Record<string, unknown>;
        if (value.type !== "tool_use" || !value.input || typeof value.input !== "object") continue;
        const input = value.input as Record<string, unknown>;
        const command = typeof input.command === "string" ? input.command : undefined;
        if (command && scanSecrets(command).length === 0) commands.push(command);
        const file = [input.file_path, input.path].find((item) => typeof item === "string");
        if (typeof file === "string") files.add(file);
      }
    }
  }
  return { agent: "claude", sessionId, path, cwd, messages, commands, files: [...files] };
}

function parseCodex(path: string): SessionCandidate {
  const records = parseLines(path) as Array<Record<string, unknown>>;
  const messages: SessionMessage[] = [];
  const commands: string[] = [];
  const files = new Set<string>();
  let cwd: string | undefined;
  let sessionId: string | undefined;
  for (const record of records) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (record.type === "session_meta") {
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.id === "string") sessionId = payload.id;
    }
    let role: "user" | "assistant" | undefined;
    let text = "";
    if (record.type === "response_item" && payload.type === "message") {
      role = payload.role === "user" ? "user" : payload.role === "assistant" ? "assistant" : undefined;
      text = textFromContent(payload.content);
    } else if (record.type === "event_msg") {
      if (payload.type === "user_message") role = "user";
      if (payload.type === "agent_message") role = "assistant";
      text = typeof payload.message === "string" ? payload.message : "";
    }
    if (role && text.trim()) {
      messages.push({ role, text: text.trim() });
      extractPaths(text).forEach((item) => files.add(item));
    }
    if (record.type === "response_item" && payload.type === "function_call") {
      const args = typeof payload.arguments === "string" ? payload.arguments : "";
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        const command = typeof parsed.cmd === "string" ? parsed.cmd : typeof parsed.command === "string" ? parsed.command : undefined;
        if (command && scanSecrets(command).length === 0) commands.push(command);
      } catch {
        // Ignore malformed or non-JSON tool arguments.
      }
    }
  }
  return { agent: "codex", sessionId, path, cwd, messages, commands, files: [...files] };
}

export function parseOpenCodeExport(value: string, path = "opencode:export"): SessionCandidate {
  const exported = JSON.parse(value) as Record<string, unknown>;
  const info = exported.info && typeof exported.info === "object"
    ? exported.info as Record<string, unknown>
    : {};
  const records = Array.isArray(exported.messages) ? exported.messages : [];
  const messages: SessionMessage[] = [];
  const commands: string[] = [];
  const files = new Set<string>();

  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const message = record as Record<string, unknown>;
    const messageInfo = message.info && typeof message.info === "object"
      ? message.info as Record<string, unknown>
      : {};
    const role = messageInfo.role === "user"
      ? "user"
      : messageInfo.role === "assistant"
        ? "assistant"
        : undefined;
    const texts: string[] = [];
    for (const rawPart of Array.isArray(message.parts) ? message.parts : []) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        texts.push(part.text.trim());
        extractPaths(part.text).forEach((item) => files.add(item));
      }
      if (part.type !== "tool" || !part.state || typeof part.state !== "object") continue;
      const state = part.state as Record<string, unknown>;
      const toolInput = state.input && typeof state.input === "object"
        ? state.input as Record<string, unknown>
        : {};
      const command = [toolInput.command, toolInput.cmd].find((item) => typeof item === "string");
      if (typeof command === "string" && scanSecrets(command).length === 0) commands.push(command);
      for (const candidate of [toolInput.file, toolInput.path, toolInput.filePath, toolInput.file_path]) {
        if (typeof candidate === "string") files.add(candidate);
      }
    }
    if (role && texts.length > 0) messages.push({ role, text: texts.join("\n") });
  }

  return {
    agent: "opencode",
    sessionId: typeof info.id === "string" ? info.id : undefined,
    path,
    cwd: typeof info.directory === "string" ? info.directory : undefined,
    messages,
    commands,
    files: [...files]
  };
}

function candidateFiles(agent: SessionAgent): string[] {
  if (agent === "opencode") return [];
  return agent === "codex"
    ? walk(resolve(homedir(), ".codex", "sessions"))
    : walk(resolve(homedir(), ".claude", "projects"));
}

export function parseSessionFile(agent: SessionAgent, path: string): SessionCandidate {
  if (agent === "codex") return parseCodex(path);
  if (agent === "claude") return parseClaude(path);
  return parseOpenCodeExport(readFileSync(path, "utf8"), path);
}

function loadOpenCodeCandidate(repositoryRoot: string, selector: string): SessionCandidate {
  if (!commandExists("opencode")) throw new Error("opencode CLI is not installed");
  const listed = runCommand("opencode", ["session", "list", "--format", "json"], {
    cwd: repositoryRoot,
    allowFailure: true
  });
  if (listed.exitCode !== 0) throw new Error(`opencode session list failed: ${listed.stderr.trim()}`);
  let sessions: Array<Record<string, unknown>>;
  try {
    const parsed = JSON.parse(listed.stdout) as unknown;
    sessions = Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
      : [];
  } catch {
    throw new Error("opencode session list returned invalid JSON");
  }
  sessions.sort((left, right) => Number(right.updated ?? 0) - Number(left.updated ?? 0));
  const selected = sessions.find((session) => {
    if (selector !== "last") return session.id === selector;
    return typeof session.directory === "string" && resolve(session.directory) === resolve(repositoryRoot);
  });
  if (!selected || typeof selected.id !== "string") {
    throw new Error(`No matching opencode session found for ${repositoryRoot}`);
  }
  const exported = runCommand("opencode", ["export", selected.id], {
    cwd: repositoryRoot,
    allowFailure: true
  });
  if (exported.exitCode !== 0) throw new Error(`opencode export failed: ${exported.stderr.trim()}`);
  return parseOpenCodeExport(exported.stdout, `opencode:${selected.id}`);
}

export interface OpenCodeResumeOptions {
  sessionName?: string;
  /** ISO timestamp from the launch receipt; prefer sessions updated around/after launch. */
  launchedAt?: string;
  /** Ignore repo sessions older than this window relative to launchedAt (default 7 days). */
  maxAgeMs?: number;
}

/**
 * Prefer an explicit OpenCode session id for resume. When the launch receipt
 * only recorded `__last__`, resolve by cwd, then title, then launch-time window.
 */
export function resolveOpenCodeResumeSessionId(
  repositoryRoot: string,
  sessionId: string,
  sessionNameOrOptions?: string | OpenCodeResumeOptions
): string {
  const options: OpenCodeResumeOptions = typeof sessionNameOrOptions === "string"
    ? { sessionName: sessionNameOrOptions }
    : sessionNameOrOptions ?? {};
  if (sessionId !== "__last__") return sessionId;
  if (!commandExists("opencode")) return sessionId;
  const listed = runCommand("opencode", ["session", "list", "--format", "json"], {
    cwd: repositoryRoot,
    allowFailure: true
  });
  if (listed.exitCode !== 0) return sessionId;
  try {
    const parsed = JSON.parse(listed.stdout) as unknown;
    if (!Array.isArray(parsed)) return sessionId;
    const sessions = parsed.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object"
    );
    sessions.sort((left, right) => Number(right.updated ?? 0) - Number(left.updated ?? 0));
    const inRepo = sessions.filter((session) =>
      typeof session.directory === "string" && resolve(session.directory) === resolve(repositoryRoot)
    );
    if (inRepo.length === 0) return sessionId;

    if (options.sessionName) {
      const exact = inRepo.find((session) =>
        typeof session.title === "string" && session.title === options.sessionName
      );
      if (typeof exact?.id === "string") return exact.id;
      const partial = inRepo.find((session) =>
        typeof session.title === "string"
        && options.sessionName
        && session.title.toLowerCase().includes(options.sessionName.toLowerCase())
      );
      if (typeof partial?.id === "string") return partial.id;
    }

    const launchedAtMs = options.launchedAt ? Date.parse(options.launchedAt) : Number.NaN;
    const maxAgeMs = options.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
    if (Number.isFinite(launchedAtMs)) {
      const inWindow = inRepo.filter((session) => {
        const updated = Number(session.updated ?? 0);
        // OpenCode may report seconds or milliseconds.
        const updatedMs = updated < 1_000_000_000_000 ? updated * 1000 : updated;
        if (!Number.isFinite(updatedMs) || updatedMs <= 0) return false;
        // Allow a small clock skew before launch, then keep recent sessions.
        return updatedMs >= launchedAtMs - 60_000 && updatedMs <= launchedAtMs + maxAgeMs;
      });
      if (typeof inWindow[0]?.id === "string") return inWindow[0].id;
    }

    const latest = inRepo[0];
    return typeof latest?.id === "string" ? latest.id : sessionId;
  } catch {
    return sessionId;
  }
}

export function loadSessionCandidate(
  agent: SessionAgent,
  repositoryRoot: string,
  selector = "last"
): SessionCandidate {
  if (agent === "opencode") return loadOpenCodeCandidate(repositoryRoot, selector);
  const candidates = candidateFiles(agent)
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)
    .slice(0, MAX_SESSION_CANDIDATES);
  for (const file of candidates) {
    const candidate = parseSessionFile(agent, file.path);
    const cwdMatches = candidate.cwd && resolve(candidate.cwd) === resolve(repositoryRoot);
    const idMatches = selector !== "last" && candidate.sessionId === selector;
    if ((selector === "last" && cwdMatches) || idMatches) return candidate;
  }
  throw new Error(`No matching ${agent} session found for ${repositoryRoot}`);
}

export function draftFromSession(candidate: SessionCandidate, maxMessages = 80): SessionDraft {
  const messages = candidate.messages.slice(-maxMessages);
  const userMessages = messages.filter((message) => message.role === "user");
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  const userTexts = userMessages.map((message) => message.text);
  const assistantTexts = assistantMessages.map((message) => message.text);
  const goal = pickGoal(userMessages);

  const completed = collectMatchingSentences(
    assistantTexts,
    /\b(?:completed|implemented|fixed|added|updated|created|resolved|located|verified|通过|完成|已实现|已修复|已添加|已更新)\b/i,
    5
  );
  // Only fall back to the last assistant sentence when it looks like progress, not planning.
  if (completed.length === 0 && assistantMessages.length > 0) {
    const last = firstSentence(assistantMessages.at(-1)!.text);
    if (/\b(?:completed|implemented|fixed|added|updated|created|resolved|located|verified|通过|完成|已实现|已修复)\b/i.test(last)) {
      completed.push(last);
    }
  }
  if (candidate.commands.length > 0) {
    completed.push(`Observed commands: ${uniqueStrings(candidate.commands.slice(-5), 5).join("; ")}`);
  }

  const attempts = dedupeAttempts(
    collectMatchingSentences(
      [...assistantTexts, ...userTexts],
      /\b(?:failed|didn't work|did not work|does not work|rejected|broke|regressed|regression|报错|失败|不行)\b/i,
      8
    ).map((approach) => ({
      approach,
      reason: "Extracted from visible session text; re-verify before retrying."
    })),
    4
  );

  const blockers = collectMatchingSentences(
    [...userTexts, ...assistantTexts],
    /\b(?:blocked(?:\s+by|\s+on)?|blocker|waiting\s+(?:on|for)|cannot|can't|need(?:s)?\s+(?:access|credentials?|permission)|阻塞|卡住|缺少)\b/i,
    4
  );

  const decisions = collectMatchingSentences(
    [...userTexts, ...assistantTexts],
    /\b(?:decided(?:\s+to)?|we'll\s+use|we\s+should|prefer(?:ring)?|chose\s+to|决定|采用|选择)\b/i,
    4
  );

  const pending = collectMatchingSentences(
    [...userTexts, ...assistantTexts],
    /\b(?:(?:still\s+)?need(?:s)?\s+to|TODO|remaining|pending|next(?:\s+step)?(?:\s+is|:)|需要继续|待办|下一步)\b/i,
    5
  );

  const acceptance = collectMatchingSentences(
    userTexts,
    /\b(?:acceptance|must|should\s+ensure|验收|必须|需要保证)\b/i,
    4
  );

  // Prefer later pending / last substantive user instruction over early planning text.
  const lastUser = [...userMessages].reverse().find((message) =>
    !isAckMessage(message.text) && message.text.trim().length >= 12
  );
  const nextFromPending = pending.at(-1) ?? pending[0];
  const nextFromAssistant = [...assistantMessages].reverse().find((message) =>
    /next(?:\s+step)?|continue(?:\s+by|\s+with)?|should\s+(?:now|next)|接下来|下一步/i.test(message.text)
  );
  const nextAction = nextFromPending
    ?? (lastUser ? firstSentence(lastUser.text) : undefined)
    ?? (nextFromAssistant ? firstSentence(nextFromAssistant.text) : undefined)
    ?? "Verify the recorded repository state and continue the unfinished task.";

  return {
    goal,
    acceptance,
    completed: uniqueStrings(completed, 6),
    pending,
    decisions,
    attempts,
    blockers,
    nextAction: clip(nextAction, 500),
    contextPaths: uniqueStrings(candidate.files, 30)
  };
}

function findDraft(value: unknown): SessionDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const object = value as Record<string, unknown>;
  if (typeof object.goal === "string" && typeof object.nextAction === "string") {
    return {
      goal: object.goal,
      acceptance: Array.isArray(object.acceptance) ? object.acceptance.map(String) : [],
      completed: Array.isArray(object.completed) ? object.completed.map(String) : [],
      pending: Array.isArray(object.pending) ? object.pending.map(String) : [],
      decisions: Array.isArray(object.decisions) ? object.decisions.map(String) : [],
      attempts: Array.isArray(object.attempts)
        ? object.attempts.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const attempt = item as Record<string, unknown>;
          return typeof attempt.approach === "string" && typeof attempt.reason === "string"
            ? [{ approach: attempt.approach, reason: attempt.reason }]
            : [];
        })
        : [],
      blockers: Array.isArray(object.blockers) ? object.blockers.map(String) : [],
      nextAction: object.nextAction,
      contextPaths: Array.isArray(object.contextPaths) ? object.contextPaths.map(String) : []
    };
  }
  for (const child of Object.values(object)) {
    const result = findDraft(child);
    if (result) return result;
  }
  return undefined;
}

export function summarizeSession(candidate: SessionCandidate): SessionDraft {
  // OpenCode has no structured-output schema flag comparable to Claude/Codex.
  // Prefer the local heuristic draft over refusing --summarize entirely.
  if (candidate.agent === "opencode") {
    return draftFromSession(candidate);
  }
  if (!commandExists(candidate.agent)) {
    throw new Error(`${candidate.agent} CLI is not installed`);
  }
  const transcript = candidate.messages.slice(-60)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n")
    .slice(-60_000);
  if (scanSecrets(transcript).length > 0) {
    throw new Error("Potential secrets found in the selected session; refusing model summarization");
  }
  const prompt = `Summarize this unfinished coding session. Do not include credentials, hidden reasoning, or unsupported claims. Return only values supported by the visible transcript.\n\n${transcript}`;
  const temporary = mkdtempSync(join(tmpdir(), "task-handoff-summary-"));
  try {
    const schemaPath = join(temporary, "schema.json");
    const resultPath = join(temporary, "result.json");
    writeFileSync(schemaPath, JSON.stringify(sessionSummaryJsonSchema), { encoding: "utf8", mode: 0o600 });
    const result = candidate.agent === "claude"
      ? runCommand("claude", [
        "-p",
        "--output-format", "json",
        "--json-schema", JSON.stringify(sessionSummaryJsonSchema),
        prompt
      ], { allowFailure: true, cwd: candidate.cwd })
      : runCommand("codex", [
        "exec",
        "--output-schema", schemaPath,
        "--output-last-message", resultPath,
        prompt
      ], { allowFailure: true, cwd: candidate.cwd });
    if (result.exitCode !== 0) throw new Error(`${candidate.agent} summarizer failed: ${result.stderr.trim()}`);
    const values = candidate.agent === "codex" && existsSync(resultPath)
      ? [readFileSync(resultPath, "utf8")]
      : result.stdout.split("\n").filter(Boolean).reverse();
    for (const value of values) {
      try {
        const parsed = JSON.parse(value) as unknown;
        const draft = findDraft(parsed);
        if (draft) return draft;
        if (parsed && typeof parsed === "object") {
          const text = (parsed as Record<string, unknown>).result;
          if (typeof text === "string") {
            const draftFromText = findDraft(JSON.parse(text));
            if (draftFromText) return draftFromText;
          }
        }
      } catch {
        // Continue looking for a structured response.
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  throw new Error(`${candidate.agent} did not return a valid structured summary`);
}
