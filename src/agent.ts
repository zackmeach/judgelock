import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadAgentRuntimeConfig,
  type EvaluatorRuntimeConfig,
} from "./config.ts";
import { describeCorpusDocs } from "./corpus-docs.ts";
import { loadEnvFileIntoProcess } from "./env-file.ts";
import {
  sendProviderChatWithTools,
  type AgentChatOptions,
  type ChatMessage,
  type ChatReply,
  type ToolCallEvent,
} from "./provider-chat.ts";

const AGENT_PROMPT_PATH = "prompts/agent.txt";

export interface AgentSession {
  root: string;
  systemPrompt: string;
  runtime: EvaluatorRuntimeConfig;
}

export interface AgentMessageOptions {
  onToolCall?: (event: ToolCallEvent) => void;
}

/** Builds the system prompt for one agent session (instructions only — docs via tools). */
export function createAgentSession(root: string): AgentSession {
  const systemPrompt = readFileSync(join(root, AGENT_PROMPT_PATH), "utf8").trim();
  const runtime = loadAgentRuntimeConfig(root);
  return {
    root,
    systemPrompt,
    runtime,
  };
}

export function describeAgent(root: string): string {
  const runtime = loadAgentRuntimeConfig(root);
  return `${runtime.model_id} (${runtime.provider}) · ${describeCorpusDocs(root)} · tools enabled`;
}

/**
 * Sends one user message to the corpus-grounded Medicare enrollment agent.
 * The agent uses tools to list, read, and search corpus/docs on demand.
 */
export async function sendAgentMessage(
  session: AgentSession,
  history: ChatMessage[],
  userMessage: string,
  messageOptions?: AgentMessageOptions,
): Promise<ChatReply> {
  const chatOptions: AgentChatOptions = {
    root: session.root,
    ...(messageOptions?.onToolCall
      ? { onToolCall: messageOptions.onToolCall }
      : {}),
  };
  return sendProviderChatWithTools(
    session.runtime,
    session.systemPrompt,
    history,
    userMessage,
    chatOptions,
  );
}

/** Convenience wrapper that loads env keys and builds a session from disk. */
export async function sendAgentMessageFromRoot(
  root: string,
  history: ChatMessage[],
  userMessage: string,
  messageOptions?: AgentMessageOptions,
): Promise<ChatReply> {
  loadEnvFileIntoProcess(root);
  const session = createAgentSession(root);
  return sendAgentMessage(session, history, userMessage, messageOptions);
}
