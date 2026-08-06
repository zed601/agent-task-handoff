const secretPatterns: Array<{ name: string; pattern: RegExp }> = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "OpenAI API key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "npm token", pattern: /\bnpm_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "Stripe secret key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: "Hugging Face token", pattern: /\bhf_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: "authorization bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: "credential assignment", pattern: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/i },
  { name: "database URL", pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/i }
];

/** Object keys that are evidence fingerprints, not secrets. */
const SKIP_OBJECT_KEYS = new Set([
  "head",
  "statusHash",
  "hash",
  "fileHashes",
  "sha",
  "sha256",
  "checksum"
]);

export interface SecretFinding {
  path: string;
  kind: string;
  preview: string;
}

export interface SecretAllowlist {
  /**
   * Substrings that suppress high-entropy findings only.
   * Known credential patterns (API keys, private keys, etc.) are never allowlisted.
   */
  patterns: string[];
}

const DEFAULT_ALLOWLIST: SecretAllowlist = { patterns: [] };
let activeAllowlist: SecretAllowlist = DEFAULT_ALLOWLIST;

/** Configure allowlist patterns for high-entropy findings (repo config / tests). */
export function configureSecretAllowlist(allowlist?: SecretAllowlist | string[]): void {
  if (!allowlist) {
    activeAllowlist = DEFAULT_ALLOWLIST;
    return;
  }
  const patterns = Array.isArray(allowlist) ? allowlist : allowlist.patterns;
  activeAllowlist = {
    patterns: patterns
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0)
  };
}

export function getSecretAllowlist(): SecretAllowlist {
  return { patterns: [...activeAllowlist.patterns] };
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

function looksLikeNonSecretToken(candidate: string): boolean {
  if (candidate.includes("/")) return true;
  // Hex digests and UUIDs are common Git / file evidence.
  if (/^[a-f0-9]{32,}$/i.test(candidate) || /^[0-9a-f-]{36}$/i.test(candidate)) return true;
  // Base64-looking padding-only or low-variety runs are usually not credentials.
  if (/^(?:AAAA|ABCD|TEST|TODO|NULL|NONE)/i.test(candidate) && candidate.length < 48) return true;
  return false;
}

function isAllowlistedHighEntropy(candidate: string): boolean {
  if (activeAllowlist.patterns.length === 0) return false;
  return activeAllowlist.patterns.some((pattern) => candidate.includes(pattern));
}

function scanString(value: string, path: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const item of secretPatterns) {
    const match = value.match(item.pattern);
    if (match) findings.push({ path, kind: item.name, preview: preview(match[0]) });
  }
  const looksLikeFilesystemPath = /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)[^\r\n]+$/.test(value)
    || /(?:^|[\s:])\/(?:private\/)?(?:var|tmp|Users|home|workspace|opt)\/[^\s]+/i.test(value);
  if (looksLikeFilesystemPath) return findings;

  const candidates = value.match(/\b[A-Za-z0-9+/=_-]{32,120}\b/g) ?? [];
  for (const candidate of candidates) {
    if (looksLikeNonSecretToken(candidate)) continue;
    if (isAllowlistedHighEntropy(candidate)) continue;
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
      if (SKIP_OBJECT_KEYS.has(key)) return [];
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
