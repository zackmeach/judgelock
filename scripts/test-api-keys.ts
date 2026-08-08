import { resolve } from "node:path";
import {
  formatApiKeyStatusBlock,
  runApiKeyTests,
} from "../src/api-key-test.ts";
import { loadEnvFileIntoProcess } from "../src/env-file.ts";

const root = resolve(import.meta.dirname, "..");
loadEnvFileIntoProcess(root);

console.log("Key status:");
console.log(formatApiKeyStatusBlock());
console.log("");

const result = await runApiKeyTests(root);
for (const line of result.lines) {
  console.log(`${line.provider}: ${line.detail}`);
}

if (result.failures.length > 0) {
  console.log("");
  console.log(`Failed: ${result.failures.join(", ")}`);
  process.exit(1);
}
