import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { checkpointSchema } from "../dist/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(projectRoot, "docs", "handoff.schema.json");
const schema = z.toJSONSchema(checkpointSchema, {
  target: "draft-7",
  reused: "ref"
});

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify({
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "TaskHandoff checkpoint",
  ...schema
}, null, 2)}\n`, "utf8");
