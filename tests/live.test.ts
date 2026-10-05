import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runApiKeyTests } from "../src/api-key-test.ts";
import {
  ANTHROPIC_ENV_KEY,
  loadEnvFile,
  OPENAI_ENV_KEY,
} from "../src/env-file.ts";
import { ROOT } from "./root.ts";

const hasOpenAiKey = (): boolean => {
  loadEnvFile(ROOT);
  return Boolean(process.env[OPENAI_ENV_KEY]);
};

const hasAnthropicKey = (): boolean => {
  loadEnvFile(ROOT);
  return Boolean(process.env[ANTHROPIC_ENV_KEY]);
};

describe("environment", () => {
  it("documents API keys in .env.example", () => {
    const example = join(ROOT, ".env.example");
    expect(existsSync(example)).toBe(true);
  });

  it("loads .env when present without throwing", () => {
    loadEnvFile(ROOT);
    expect(true).toBe(true);
  });
});

describe.skipIf(!hasOpenAiKey())("live OpenAI API key", () => {
  it("passes the smoke test", async () => {
    const result = await runApiKeyTests(ROOT);
    const openai = result.lines.find((line) => line.provider === "OpenAI");
    expect(openai?.ok).toBe(true);
    expect(openai?.detail).toContain("OK");
  });
});

describe.skipIf(!hasAnthropicKey())("live Anthropic API key", () => {
  it("passes the smoke test", async () => {
    const result = await runApiKeyTests(ROOT);
    const anthropic = result.lines.find((line) => line.provider === "Anthropic");
    expect(anthropic?.ok).toBe(true);
    expect(anthropic?.detail).toContain("OK");
  });
});
