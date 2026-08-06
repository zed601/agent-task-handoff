# AGENTS.md

## Cursor Cloud specific instructions

TaskHandoff (`agent-task-handoff`) is a single Node.js/TypeScript **CLI** published to npm as the `handoff` binary. There is no server or web UI — it captures a coding task's state inside a Git repo and produces a portable "recovery prompt" for the next coding agent. Everything runs locally.

- Package manager is **pnpm** (`pnpm-lock.yaml`); Node **>=20** is required (the VM has Node 22). The update script runs `pnpm install`.
- Standard scripts live in `package.json`: `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm dev`.
- Run the CLI in dev mode with `pnpm dev -- <args>` (this is `tsx src/cli.ts`). The CLI acts on the **current working directory**, which must be a Git repo, so `cd` into a target repo (or a throwaway one) before invoking commands like `handoff snap`, `handoff go`, `handoff verify`, `handoff doctor`.
- `pnpm test` **builds `dist/` first** and then runs `vitest run`; the integration tests in `test/cli.test.ts` execute the compiled `dist/cli.js`, so a stale/missing build is rebuilt automatically by the test script.

### Non-obvious gotcha: the `handoff` binary must be on PATH for the full test suite

One test (`test/cli.test.ts > runs init, checkpoint, inspect, verify, export, and import`) calls `handoff doctor --json`. The `doctor` command exits with code **2** whenever `ok` is false, and `ok = initialized && handoffCommand`, where `handoffCommand` is true only when a `handoff` executable is found on `PATH`. `execFileSync` turns that non-zero exit into a thrown error, so this test fails unless `handoff` is globally linked.

To satisfy this, the `handoff` CLI is linked globally during environment setup via `pnpm link --global` (which requires pnpm's global bin dir, created once with `pnpm setup`; the resulting `PNPM_HOME`/PATH entry is in `~/.bashrc`). This link and PATH entry persist in the VM snapshot, so `pnpm test` should be fully green out of the box. If `handoff` is ever missing from PATH (e.g. `which handoff` fails), re-link it:

```bash
pnpm setup            # only if `pnpm link` reports no global bin dir; then start a new shell
pnpm link --global    # from the repo root; symlinks the `handoff` bin to this checkout
```

The global link points at this checkout's `dist/cli.js`, which is gitignored and rebuilt by `pnpm build`/`pnpm test`, so the link keeps working after rebuilds.

### Other notes

- Several commands intentionally use non-zero exit codes as signals: `handoff verify` exits `2` on **stale** evidence and `handoff doctor` exits `2` when not fully ready. This is by design, not a bug.
- Editing the canonical Skill? Run `pnpm sync:integrations` to propagate it into `integrations/`; `test/integrations.test.ts` checks they stay in sync.
