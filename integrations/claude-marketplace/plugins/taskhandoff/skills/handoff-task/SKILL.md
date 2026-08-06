---
name: handoff-task
description: Save, verify, resume, rescue, transfer, or export unfinished coding tasks across sessions, humans, Claude Code, Codex, OpenCode, GitHub Copilot CLI, and Cursor. Use when the user asks to preserve progress, continue in a new session, switch coding agents, hand a task to another agent or person, recover a stuck task, check whether old context is stale, or create a handoff document.
---

# Handoff Task

Use the installed `handoff` CLI as the deterministic engine. Do not reproduce Git evidence, hashes, secret scanning, or checkpoint storage in the prompt.

## Route the request

1. Prefer `handoff` / `handoff doctor --json` only when diagnosing setup.
2. First mutating commands auto-create `.handoff/` and update `.gitignore`. Mention that briefly after it happens.
3. Map the user's outcome using [references/intent-mapping.md](references/intent-mapping.md).
4. Ask only for a missing decision that changes the result. Prefer omitting `--to` when `defaultAgent` or a single installed agent can be used.

## Create checkpoints safely

Summarize the visible task into goal, acceptance criteria, completed work, pending work, confirmed decisions, failed attempts, blockers, relevant files, and one concrete next action.

Show the user a concise preview before saving inferred state. After confirmation:

- Save only: `handoff snap --goal "..."` (auto-captures dirty files)
- Save and hand off: `handoff go --goal "..." --name "<session-name>"`

Dirty Git files are attached automatically when `--ref` is omitted. `--next` defaults to the goal. Never place credentials, environment variables, raw tool output, hidden reasoning, or full transcripts in arguments.

Treat a direct request such as “save this checkpoint now with these details” as confirmation. Secret scanning remains mandatory and must never be bypassed.

## Resume or transfer

For a direct cross-agent handoff request, prefer:

```bash
handoff go --goal "..." --name "<target-session-name>"
# or, for an existing checkpoint:
handoff go --name "<target-session-name>"
```

`go` auto-initializes, auto-picks the target when possible, creates a checkpoint when `--goal`/`--from`/progress flags are supplied, verifies freshness, secret-scans the recovery prompt, writes a fallback under `.handoff/exports/`, and copies it to the clipboard. When the target agent CLI is installed, `go` launches it unless `--no-exec` is passed.

Pass `--to` only when multiple agents are installed and `defaultAgent` is unset/unavailable. Use `--to human` for a person.

Report stale reasons from the receipt instead of hiding them. If clipboard access is unavailable, direct the user to the prompt file. Use `--no-copy` only when the user asks not to touch the clipboard. Add `--no-exec` when the user wants a prompt without launching.

For Claude, a successful launch assigns the exact name through Claude's native `--name` option, preallocates a native session UUID, and saves a launch receipt under `.handoff/launches/`. For Codex, a successful launch saves a receipt keyed by the session name (or `__last__`) so `handoff enter` can run `codex resume <name>` or `codex resume --last`. When invoked from an agent-hosted process, the default `auto` launch mode opens a visible OS terminal window on macOS, Linux, and Windows. Use `--launch-mode inline` only when the user explicitly wants the current terminal. To return to a session that TaskHandoff launched earlier, use `handoff enter`; it resumes the recorded identity and does not resend the recovery prompt.

Copilot and Cursor cannot be used as `--from` rescue sources; use `handoff snap` / `handoff go --goal ...` from the visible conversation instead.

## Rescue prior sessions

Use `handoff go --from claude|codex|opencode` only when the user wants to recover a prior local session. Explain that session extraction is experimental and requires review. Add `--summarize` only for Claude or Codex after the user accepts possible model usage and network cost.

## Report the result

Return the task ID, revision, freshness status, target, target session name, prompt path, clipboard status, launch status, and the one remaining user action. If the target was launched successfully, say no manual paste remains. If the CLI exits nonzero, report its exact safe error and do not claim the handoff succeeded.
