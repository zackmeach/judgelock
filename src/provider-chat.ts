import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { EvaluatorRuntimeConfig } from "./config.ts";
import {
  ANTHROPIC_ENV_KEY,
  OPENAI_ENV_KEY,
  requireEnv,
} from "./env-file.ts";
import {
  AGENT_TOOLS,
  executeAgentTool,
} from "./agent-tools.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatReply {
  content: string;
  resolved_model_id: string;
}

export interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

export interface AgentChatOptions {
  root: string;
  onToolCall?: (event: ToolCallEvent) => void;
}

const MAX_TOOL_ROUNDS = 8;

const OPENAI_AGENT_TOOLS = AGENT_TOOLS.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
})) satisfies OpenAI.Chat.ChatCompletionTool[];

const ANTHROPIC_AGENT_TOOLS = AGENT_TOOLS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.parameters as Anthropic.Tool.InputSchema,
})) satisfies Anthropic.Tool[];

const ANTHROPIC_THINKING_BUDGET: Record<
  NonNullable<EvaluatorRuntimeConfig["decoding"]["reasoning_effort"]>,
  number
> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
};

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function anthropicRequestExtras(
  runtime: EvaluatorRuntimeConfig,
  systemPrompt: string | undefined,
): Record<string, unknown> {
  return {
    ...(systemPrompt ? { system: systemPrompt } : {}),
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
    ...(runtime.decoding.reasoning_effort !== undefined
      ? {
          thinking: {
            type: "enabled" as const,
            budget_tokens:
              ANTHROPIC_THINKING_BUDGET[runtime.decoding.reasoning_effort],
          },
        }
      : {}),
  };
}

async function chatOpenAiWithTools(
  runtime: EvaluatorRuntimeConfig,
  systemPrompt: string | undefined,
  history: ChatMessage[],
  userMessage: string,
  options: AgentChatOptions,
): Promise<ChatReply> {
  const client = new OpenAI({ apiKey: requireEnv(OPENAI_ENV_KEY) });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: userMessage });

  let resolved_model_id = runtime.model_id;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model: runtime.model_id,
      messages,
      tools: OPENAI_AGENT_TOOLS,
      max_completion_tokens: runtime.decoding.max_tokens,
      ...(runtime.decoding.top_p !== undefined
        ? { top_p: runtime.decoding.top_p }
        : {}),
      ...(runtime.decoding.stop_sequences.length > 0
        ? { stop: runtime.decoding.stop_sequences }
        : {}),
      ...(runtime.decoding.temperature !== undefined
        ? { temperature: runtime.decoding.temperature }
        : {}),
      ...(runtime.decoding.reasoning_effort !== undefined
        ? { reasoning_effort: runtime.decoding.reasoning_effort }
        : {}),
    });

    resolved_model_id = response.model ?? runtime.model_id;
    const choice = response.choices[0]?.message;
    if (!choice) {
      return { content: "", resolved_model_id };
    }

    const toolCalls = choice.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return {
        content: choice.content?.trim() ?? "",
        resolved_model_id,
      };
    }

    messages.push({
      role: "assistant",
      content: choice.content ?? "",
      tool_calls: toolCalls,
    });

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const args = parseToolArgs(call.function.arguments);
      const result = executeAgentTool(options.root, call.function.name, args);
      options.onToolCall?.({
        name: call.function.name,
        args,
        result,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  throw new Error(`agent exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
}

async function chatAnthropicWithTools(
  runtime: EvaluatorRuntimeConfig,
  systemPrompt: string | undefined,
  history: ChatMessage[],
  userMessage: string,
  options: AgentChatOptions,
): Promise<ChatReply> {
  const client = new Anthropic({ apiKey: requireEnv(ANTHROPIC_ENV_KEY) });
  const messages: Anthropic.MessageParam[] = [
    ...history.map((msg) => ({
      role: msg.role,
      content: msg.content,
    })),
    { role: "user", content: userMessage },
  ];

  let resolved_model_id = runtime.model_id;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.messages.create({
      model: runtime.model_id,
      max_tokens: runtime.decoding.max_tokens,
      messages,
      tools: ANTHROPIC_AGENT_TOOLS,
      ...anthropicRequestExtras(runtime, systemPrompt),
    });

    resolved_model_id = response.model;

    const textBlocks = response.content.filter((part) => part.type === "text");
    const toolUses = response.content.filter(
      (part) => part.type === "tool_use",
    );

    if (toolUses.length === 0) {
      const content = textBlocks
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
        .trim();
      return { content, resolved_model_id };
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      if (toolUse.type !== "tool_use") continue;
      const args = toolUse.input as Record<string, unknown>;
      const result = executeAgentTool(options.root, toolUse.name, args);
      options.onToolCall?.({ name: toolUse.name, args, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`agent exceeded ${MAX_TOOL_ROUNDS} tool rounds`);
}

/** One agent turn with corpus tool support. */
export async function sendProviderChatWithTools(
  runtime: EvaluatorRuntimeConfig,
  systemPrompt: string | undefined,
  history: ChatMessage[],
  userMessage: string,
  options: AgentChatOptions,
): Promise<ChatReply> {
  switch (runtime.provider) {
    case "openai":
      return chatOpenAiWithTools(
        runtime,
        systemPrompt,
        history,
        userMessage,
        options,
      );
    case "anthropic":
      return chatAnthropicWithTools(
        runtime,
        systemPrompt,
        history,
        userMessage,
        options,
      );
    default: {
      const unexpected: never = runtime.provider;
      throw new Error(`unsupported provider: ${unexpected}`);
    }
  }
}
