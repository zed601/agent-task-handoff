import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "skills", "handoff-task");
const targets = [
  resolve(root, "integrations", "codex-plugin", "skills", "handoff-task"),
  resolve(root, "integrations", "claude-marketplace", "plugins", "taskhandoff", "skills", "handoff-task")
];

const packageVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const manifests = [
  resolve(root, "integrations", "codex-plugin", ".codex-plugin", "plugin.json"),
  resolve(root, "integrations", "claude-marketplace", "plugins", "taskhandoff", ".claude-plugin", "plugin.json")
];

for (const target of targets) {
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
}

for (const manifestPath of manifests) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = packageVersion;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

const marketplacePath = resolve(root, "integrations", "claude-marketplace", ".claude-plugin", "marketplace.json");
const marketplace = JSON.parse(readFileSync(marketplacePath, "utf8"));
marketplace.version = packageVersion;
for (const plugin of marketplace.plugins ?? []) {
  if (plugin.name === "taskhandoff") plugin.version = packageVersion;
}
writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
