# Security model

Task handoffs may contain source code, commands, customer identifiers, and credentials. The MVP follows these defaults:

- `.handoff/` is ignored by Git.
- Raw transcripts and full diffs are not persisted.
- Secret scanning runs before checkpoint save, export, clipboard copy, summarization, and agent launch.
- Common API keys (OpenAI, Anthropic, GitHub, npm, Slack, Stripe, Google, Hugging Face), private keys, bearer tokens, database URLs (including Redis), credential assignments, and unexplained high-entropy values are blocked.
- Evidence fingerprints (`head`, `hash`, `fileHashes`, checksums) and filesystem path strings are skipped to reduce false positives.
- Optional `secretAllowlist` entries in `.handoff/config.yaml` suppress **high-entropy** findings that contain those substrings. Known credential patterns are never allowlisted.
- `--yes` bypasses terminal questions but never bypasses secret scanning.
- Child processes receive argument arrays with `shell: false`.
- `--exec` never adds permission-bypass or sandbox-bypass flags.

The scanner is a safety net, not a proof that content is safe. Review exported handoffs before sharing them. If a false positive is found, remove or redact the value rather than weakening scanning globally.
