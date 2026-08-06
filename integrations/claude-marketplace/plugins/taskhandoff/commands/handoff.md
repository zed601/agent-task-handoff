---
description: Save, verify, rescue, transfer, or export the current coding task
argument-hint: "[go|snap|checkpoint|verify|rescue] [codex|claude|opencode|copilot|cursor|human]"
allowed-tools: Bash(handoff:*)
---

Use the bundled `handoff-task` workflow and the installed `handoff` CLI to handle this request:

```text
$ARGUMENTS
```

If no argument is supplied, prepare a checkpoint of the visible current task and prefer `handoff go --goal "..."` or `handoff snap --goal "..."`. Start with `handoff doctor --json` only when diagnosing setup.

Interpret common arguments as follows:

- `verify`: run `handoff verify` for the requested or latest task.
- `snap` / `save`: run `handoff snap --goal "..."`.
- `codex`, `claude`, `opencode`, `copilot`, or `cursor`: prefer `handoff go --goal "..." --name <session-name>`; add `--to` only when needed.
- `human`: `handoff go --to human`.
- `rescue <target>`: run prior-session rescue with `handoff go --from ...`.

Initialization is automatic. Dirty files are auto-captured when `--ref` is omitted.

Never include secrets, raw transcripts, hidden reasoning, or complete environment variables. Never bypass secret scanning. Do not add `--summarize` without consent to possible model usage, and use it only for Claude or Codex sources. A direct handoff request authorizes `handoff go` defaults (clipboard copy, fallback prompt file, and launch when the target CLI is installed). Use `--no-exec` when the user wants a prompt without launching.

Report the task ID, revision, freshness result, target, target session name, prompt path, clipboard status, launch status, and the one remaining user action.
