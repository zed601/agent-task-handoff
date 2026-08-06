# Architecture

TaskHandoff is split into four layers:

```text
Claude/Codex/OpenCode/manual input
          │
          ▼
 Source adapters ── optional explicit summarizer
          │
          ▼
 Versioned checkpoint + Git evidence + provenance
          │
          ▼
 Freshness and secret validators
          │
          ▼
 Codex / Claude / OpenCode / Copilot / Cursor renderer and launcher
```

## Checkpoint protocol

`schemaVersion` is independent from the CLI version. Checkpoints are immutable and stored as `.handoff/tasks/<task>/revisions/0001.json`; `latest.json` is only a pointer. Imports become a new local revision instead of overwriting existing evidence.

The protocol records task state, not model hidden state or chain-of-thought. Repository evidence contains branch, HEAD, porcelain-status hash, changed file names, diff stat, and selected file hashes. Complete diffs and raw transcripts are excluded by default. Checkpoints retain the complete changed-file list, while agent prompts compact very large lists into top-level path counts so generated cache epochs cannot overwhelm the recovery message. When `HEAD` is `UNBORN` (no commits yet), freshness checks ignore the full working-tree status hash and only compare recorded file hashes and branch, so unrelated untracked churn does not false-positive as stale. Manual checkpoints and `snap`/`go` without `--ref` auto-attach up to 20 dirty paths as context refs.

## Session adapters

The Codex adapter accepts `session_meta`, `event_msg`, and `response_item` records. The Claude adapter accepts top-level `user` and `assistant` records, ignores sidechains and attachments, and extracts only visible text plus limited tool metadata. The OpenCode adapter selects sessions through `opencode session list --format json` and parses an in-memory `opencode export`; reasoning and tool output are ignored. Unknown and malformed records are ignored so format additions do not crash local extraction.

Local draft extraction (the default without `--summarize`) mines visible transcript text for goal, acceptance, completed work, pending next steps, decisions, failed attempts, and blockers, then clips long phrases and deduplicates. Observed commands are recorded as completed evidence. Claude/Codex session discovery caps at the 80 most recently modified `.jsonl` files so large session trees do not stall rescue. Agent summarization remains opt-in for Claude and Codex only; its result remains `agent-inferred`.

A session is selected only when its recorded `cwd` resolves to the current repository, unless the user supplies an exact session ID.

Copilot and Cursor are render-and-launch targets because their official CLIs accept an initial interactive prompt but do not expose a compatible read-only prior-session export. Cursor's own `agent resume` keeps context inside Cursor; TaskHandoff remains responsible for cross-agent transfer.

## Workflows

Workflows are YAML-backed linear state machines. One step may be active at a time. Completing a step activates the next; blocking a step records a reason without advancing. Parallel steps, branches, leases, and distributed scheduling are intentionally out of scope for the MVP.
