import { describe, expect, it } from "vitest";
import { assertNoSecrets, scanSecrets } from "../src/security.js";

describe("secret scanning", () => {
  it("detects common credentials", () => {
    const value = { note: "token=abcdefghijklmnopqrstuvwx123456" };
    expect(scanSecrets(value).some((item) => item.kind === "credential assignment")).toBe(true);
    expect(() => assertNoSecrets(value)).toThrow(/Potential secrets/);
  });

  it("does not flag Git and file hashes", () => {
    expect(scanSecrets({ head: "a".repeat(40), fileHashes: { "a.ts": "b".repeat(64) } })).toEqual([]);
  });

  it("does not treat an embedded temporary path as a secret", () => {
    expect(scanSecrets("Root: /private/var/folders/abc123/T/handoff-cli-DVqOej/project")).toEqual([]);
  });
});
