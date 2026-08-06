import { describe, expect, it } from "vitest";
import { checkpointSchema } from "../src/schema.js";
import { checkpointFixture } from "./helpers.js";

describe("checkpoint schema", () => {
  it("accepts a valid versioned checkpoint", () => {
    expect(checkpointSchema.parse(checkpointFixture("/repo")).schemaVersion).toBe("1.0.0");
  });

  it("rejects unversioned and empty tasks", () => {
    const value = checkpointFixture("/repo") as Record<string, unknown>;
    value.schemaVersion = "0.0.1";
    expect(() => checkpointSchema.parse(value)).toThrow();
  });
});
