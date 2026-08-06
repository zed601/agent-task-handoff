# Security model

Task handoffs may contain source code, commands, customer identifiers, and credentials. The MVP follows these defaults:

- `.handoff/` is ignored by Git.
- Raw transcripts and full diffs are not persisted.
- Secret scanning runs before checkpoint save, export, clipboard copy, summarization, and agent launch.
- Common API keys, private keys, bearer tokens, database URLs, credential assignments, and unexplained high-entropy values are blocked.
- `--yes` bypasses terminal questions but never bypasses secret scanning.
- Child processes receive argument arrays with `shell: false`.
- `--exec` never adds permission-bypass or sandbox-bypass flags.

The scanner is a safety net, not a proof that content is safe. Review exported handoffs before sharing them. If a false positive is found, remove or redact the value rather than weakening scanning globally.
