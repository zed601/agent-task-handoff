import { describe, expect, it } from "vitest";
import { assertNoSecrets, configureSecretAllowlist, scanSecrets } from "../src/security.js";

/** Build sample credentials at runtime so the repo never stores scanner-triggering literals. */
function sample(parts: string[]): string {
  return parts.join("");
}

describe("secret scanning", () => {
  it("detects common credentials", () => {
    const value = { note: sample(["token=", "abcdefghijklmnopqrstuvwx123456"]) };
    expect(scanSecrets(value).some((item) => item.kind === "credential assignment")).toBe(true);
    expect(() => assertNoSecrets(value)).toThrow(/Potential secrets/);
  });

  it("detects provider-specific API tokens", () => {
    const samples = [
      { text: sample(["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz012345"]), kind: "Anthropic API key" },
      { text: sample(["npm_", "abcdefghijklmnopqrstuvwxyz012345"]), kind: "npm token" },
      { text: sample(["xoxb-", "1234567890-", "abcdefghijklmnop"]), kind: "Slack token" },
      { text: sample(["sk_live_", "abcdefghijklmnopqrstuv"]), kind: "Stripe secret key" },
      { text: sample(["AIzaSyA-", "abcdefghijklmnopqrstuvwx"]), kind: "Google API key" },
      { text: sample(["hf_", "abcdefghijklmnopqrstuvwxyz0123456789"]), kind: "Hugging Face token" },
      { text: sample(["redis://user:", "super-secret", "@localhost:6379/0"]), kind: "database URL" }
    ];
    for (const sampleCase of samples) {
      expect(scanSecrets(sampleCase.text).some((item) => item.kind === sampleCase.kind)).toBe(true);
    }
  });

  it("does not flag Git and file hashes", () => {
    expect(scanSecrets({ head: "a".repeat(40), fileHashes: { "a.ts": "b".repeat(64) } })).toEqual([]);
  });

  it("does not treat an embedded temporary path as a secret", () => {
    expect(scanSecrets("Root: /private/var/folders/abc123/T/handoff-cli-DVqOej/project")).toEqual([]);
    expect(scanSecrets("cwd=/home/ubuntu/.cache/tmp-abcdef0123456789abcdef0123456789")).toEqual([]);
  });

  it("allowlists high-entropy substrings but never known credential patterns", () => {
    const highEntropy = sample(["Zm9vYmFyYmF6cXV4am9rZWx", "tbm9wcXJzdHV2d3h5ejEyMzQ1Ng"]);
    expect(scanSecrets(highEntropy).some((item) => item.kind === "high-entropy value")).toBe(true);
    configureSecretAllowlist([highEntropy.slice(0, 12)]);
    try {
      expect(scanSecrets(highEntropy)).toEqual([]);
      const apiKey = sample(["sk-ant-api03-", "abcdefghijklmnopqrstuvwxyz012345"]);
      expect(scanSecrets(apiKey).some((item) => item.kind === "Anthropic API key")).toBe(true);
    } finally {
      configureSecretAllowlist([]);
    }
  });
});
