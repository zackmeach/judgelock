import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import {
  ANTHROPIC_ENV_KEY,
  OPENAI_ENV_KEY,
  formatEnvKeyStatus,
  getEnvKeyStatus,
  loadEnvFile,
} from "./env-file.ts";

export interface ApiKeyTestLine {
  provider: string;
  ok: boolean;
  detail: string;
}

export interface ApiKeyTestResult {
  lines: ApiKeyTestLine[];
  failures: string[];
}

async function testOpenAi(): Promise<ApiKeyTestLine> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      provider: "OpenAI",
      ok: false,
      detail: "SKIP - OPENAI_API_KEY not set",
    };
  }

  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_completion_tokens: 16,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? "";
  return {
    provider: "OpenAI",
    ok: true,
    detail: `OK - model=${response.model} response="${text.slice(0, 80)}"`,
  };
}

async function testAnthropic(): Promise<ApiKeyTestLine> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      provider: "Anthropic",
      ok: false,
      detail: "SKIP - ANTHROPIC_API_KEY not set",
    };
  }

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  const block = response.content.find((part) => part.type === "text");
  const text =
    block && block.type === "text" ? block.text.trim() : "(no text block)";
  return {
    provider: "Anthropic",
    ok: true,
    detail: `OK - model=${response.model} response="${text.slice(0, 80)}"`,
  };
}

export async function runApiKeyTests(root: string): Promise<ApiKeyTestResult> {
  loadEnvFile(root);

  const lines: ApiKeyTestLine[] = [];
  const failures: string[] = [];

  for (const [name, fn] of [
    ["OpenAI", testOpenAi],
    ["Anthropic", testAnthropic],
  ] as const) {
    try {
      const line = await fn();
      lines.push(line);
      if (!line.ok && !line.detail.startsWith("SKIP")) {
        failures.push(name);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      lines.push({ provider: name, ok: false, detail: `FAIL - ${message}` });
      failures.push(name);
    }
  }

  return { lines, failures };
}

export function formatApiKeyStatusBlock(): string {
  const openai = getEnvKeyStatus(OPENAI_ENV_KEY);
  const anthropic = getEnvKeyStatus(ANTHROPIC_ENV_KEY);
  return [
    `  ${OPENAI_ENV_KEY}: ${formatEnvKeyStatus(openai)}`,
    `  ${ANTHROPIC_ENV_KEY}: ${formatEnvKeyStatus(anthropic)}`,
  ].join("\n");
}
