import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { loadEvaluatorRuntimeConfig } from "./config.ts";
import type { EvaluatorRuntimeConfig } from "./config.ts";
import { loadEnvFileIntoProcess } from "./env-file.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  content: string;
  resolved_model_id: string;
}

function requireOpenAiKey(): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  return apiKey;
}

function requireAnthropicKey(): string {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  return apiKey;
}

async function chatOpenAi(
  runtime: EvaluatorRuntimeConfig,
  history: ChatMessage[],
  userMessage: string,
): Promise<ChatReply> {
  const client = new OpenAI({ apiKey: requireOpenAiKey() });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model: runtime.model_id,
    messages,
    max_completion_tokens: runtime.decoding.max_tokens,
    ...(runtime.decoding.top_p !== undefined
      ? { top_p: runtime.decoding.top_p }
      : {}),
    ...(runtime.decoding.stop_sequences.length > 0
      ? { stop: runtime.decoding.stop_sequences }
      : {}),
    // gpt-5.6-luna only supports the default temperature (1).
    ...(runtime.model_id.includes("luna")
      ? {}
      : { temperature: runtime.decoding.temperature }),
  });

  const content = response.choices[0]?.message?.content?.trim() ?? "";
  return {
    content,
    resolved_model_id: response.model ?? runtime.model_id,
  };
}

async function chatAnthropic(
  runtime: EvaluatorRuntimeConfig,
  history: ChatMessage[],
  userMessage: string,
): Promise<ChatReply> {
  const client = new Anthropic({ apiKey: requireAnthropicKey() });
  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await client.messages.create({
    model: runtime.model_id,
    max_tokens: runtime.decoding.max_tokens,
    messages,
    ...(runtime.decoding.temperature !== undefined
      ? { temperature: runtime.decoding.temperature }
      : {}),
    ...(runtime.decoding.top_p !== undefined
      ? { top_p: runtime.decoding.top_p }
      : {}),
    ...(runtime.decoding.top_k !== undefined
      ? { top_k: runtime.decoding.top_k }
      : {}),
    ...(runtime.decoding.stop_sequences.length > 0
      ? { stop_sequences: runtime.decoding.stop_sequences }
      : {}),
  });

  const block = response.content.find((part) => part.type === "text");
  const content =
    block && block.type === "text" ? block.text.trim() : "";

  return {
    content,
    resolved_model_id: response.model,
  };
}

/**
 * Sends one user turn to the configured evaluator model and returns its reply.
 * This is open conversation for probing the model — not the structured judge
 * verdict path used in validation runs.
 */
export async function sendEvaluatorChat(
  root: string,
  history: ChatMessage[],
  userMessage: string,
): Promise<ChatReply> {
  loadEnvFileIntoProcess(root);
  const runtime = loadEvaluatorRuntimeConfig(root);

  switch (runtime.provider) {
    case "openai":
      return chatOpenAi(runtime, history, userMessage);
    case "anthropic":
      return chatAnthropic(runtime, history, userMessage);
    default: {
      const unexpected: never = runtime.provider;
      throw new Error(`unsupported provider: ${unexpected}`);
    }
  }
}

export function describeEvaluatorChat(root: string): string {
  const runtime = loadEvaluatorRuntimeConfig(root);
  return `${runtime.model_id} (${runtime.provider})`;
}
