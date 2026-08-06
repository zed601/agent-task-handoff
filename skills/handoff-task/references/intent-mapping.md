# Intent mapping

| User intent | CLI operation |
|---|---|
| Save progress only | `handoff snap --goal "..."` |
| Save and hand off | `handoff go --goal "..."` |
| Check whether an old handoff is still valid | `handoff verify` |
| Continue latest checkpoint in another agent | `handoff go` |
| Re-enter a launched Claude/Codex session | `handoff enter` |
| Preview a recovery prompt | `handoff resume` |
| Hand the task to a person | `handoff go --to human` |
| Produce a shareable document | `handoff export --format markdown` |
| Recover a previous Claude/Codex/OpenCode session | `handoff go --from <source>` |
| Inspect the latest recorded state | `handoff inspect` |
| Diagnose setup problems | `handoff` or `handoff doctor` |

## Minimal flags

Most handoffs only need:

```text
--goal <text>
--name <session-name>   # when handing to an agent
--to <agent>            # only if multiple agents are installed
--no-exec               # when you want a prompt without launching
```

Optional detail flags:

```text
--task <id>
--acceptance <item>
--completed <item>
--pending <item>
--decision <item>
--attempt <approach::reason>
--blocker <item>
--next <text>
--ref <path>
--yes
```

## Examples

“Save where we are”:

```bash
handoff snap --goal "Prevent duplicate webhook credits"
```

“Save and continue in the default/installed agent”:

```bash
handoff go --goal "Prevent duplicate webhook credits" --name "webhook-fix"
```

“Give the latest checkpoint to Codex without launching”:

```bash
handoff go --to codex --name "webhook-fix" --no-exec
```

“Continue in Cursor CLI”:

```bash
handoff go --to cursor --name "webhook-fix"
```

“Create a handoff note for my teammate”:

```bash
handoff go --to human --no-copy --print
```
