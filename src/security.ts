const secretPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: "authorization bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "credential assignment", pattern: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i },
  { name: "database URL", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/i }
];

export interface SecretFinding {
  path: string;
  kind: string;
  preview: string;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function preview(value: string): string {
  if (value.length <= 10) return "[redacted]";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function scanString(value: string, path: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const item of secretPatterns) {
    const match = value.match(item.pattern);
    if (match) findings.push({ path, kind: item.name, preview: preview(match[0]) });
  }
  const looksLikeFilesystemPath = /^(?:\.{0,2}\/|~\/)[^\r\n]+$/.test(value);
  const candidates = looksLikeFilesystemPath
    ? []
    : value.match(/\b[A-Za-z0-9+/=_-]{32,120}\b/g) ?? [];
  for (const candidate of candidates) {
    if (candidate.includes("/")) continue;
    if (/^[a-f0-9]{32,}$/i.test(candidate) || /^[0-9a-f-]{36}$/i.test(candidate)) continue;
    if (entropy(candidate) >= 4.5) {
      findings.push({ path, kind: "high-entropy value", preview: preview(candidate) });
    }
  }
  return findings;
}

export function scanSecrets(value: unknown, path = "root"): SecretFinding[] {
  if (typeof value === "string") return scanString(value, path);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanSecrets(entry, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => {
      if (["head", "statusHash", "hash", "fileHashes"].includes(key)) return [];
      return scanSecrets(entry, `${path}.${key}`);
    });
  }
  return [];
}

export function assertNoSecrets(value: unknown): void {
  const findings = scanSecrets(value);
  if (findings.length === 0) return;
  const detail = findings
    .slice(0, 8)
    .map((finding) => `${finding.path}: ${finding.kind} (${finding.preview})`)
    .join("\n");
  throw new Error(`Potential secrets detected. Redact them before continuing:\n${detail}`);
}
