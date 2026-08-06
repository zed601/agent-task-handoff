import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup-path.ts"],
    coverage: { reporter: ["text", "json", "html"] }
  }
});
