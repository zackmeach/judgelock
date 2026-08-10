import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Repository root (parent of tests/). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
