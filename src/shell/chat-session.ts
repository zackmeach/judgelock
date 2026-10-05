import {
  createAgentSession,
  describeAgent,
  sendAgentMessage,
  type AgentSession,
} from "../agent.ts";
import {
  loadEvaluatorConfig,
  loadEvaluatorRuntimeConfig,
  loadReferenceDocuments,
} from "../config.ts";
import { loadEnvFile } from "../env-file.ts";
import { callJudge, parseVerdict } from "../judge.ts";
import type { ChatMessage } from "../provider-chat.ts";
import type { GoldenCase } from "../types.ts";
import type { ShellContext } from "./handlers.ts";

async function sendAndPrint(
  ctx: ShellContext,
  session: AgentSession,
  history: ChatMessage[],
  userMessage: string,
): Promise<void> {
  try {
    const reply = await sendAgentMessage(session, history, userMessage, {
      onToolCall: (event) => {
        const args = JSON.stringify(event.args);
        const preview = event.result.length > 120
          ? `${event.result.slice(0, 120)}...`
          : event.result;
        ctx.writeln(`[tool ${event.name} ${args}]`);
        ctx.writeln(`[tool result ${preview}]`);
      },
    });
    history.push({ role: "user", content: userMessage });
    history.push({ role: "assistant", content: reply.content });
    if (reply.content) {
      ctx.writeln(reply.content);
    } else {
      ctx.writeln("(empty response)");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.writeln(`error: ${message}`);
  }
  ctx.writeln("");
}

async function gradeLastExchange(
  ctx: ShellContext,
  history: ChatMessage[],
): Promise<void> {
  if (history.length < 2) {
    ctx.writeln("Nothing to grade yet — ask a question first.");
    ctx.writeln("");
    return;
  }

  const lastAssistant = history.at(-1);
  const lastUser = history.at(-2);
  if (
    lastUser?.role !== "user" ||
    lastAssistant?.role !== "assistant"
  ) {
    ctx.writeln("Could not find a question/answer pair to grade.");
    ctx.writeln("");
    return;
  }

  ctx.writeln("Running judge on the last exchange...");
  const config = loadEvaluatorConfig(ctx.root);
  const runtime = loadEvaluatorRuntimeConfig(ctx.root);
  const testCase: GoldenCase = {
    id: "chat-interactive",
    question: lastUser.content,
    answer: lastAssistant.content,
    human_label: "pass",
    human_severity: "standard",
  };

  try {
    const documents = loadReferenceDocuments(ctx.root);
    const { raw } = await callJudge(config, documents, testCase, {
      provider: runtime.provider,
    });
    const verdict = parseVerdict(raw);
    ctx.writeln(`verdict: ${verdict.label} (${verdict.severity})`);
    ctx.writeln(`evidence: ${verdict.evidence}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.writeln(`grade error: ${message}`);
  }
  ctx.writeln("");
}

export async function runChatSession(
  ctx: ShellContext,
  initialMessage?: string,
): Promise<void> {
  loadEnvFile(ctx.root);

  let session: AgentSession;
  try {
    session = createAgentSession(ctx.root);
    ctx.writeln(`Medicare enrollment agent: ${describeAgent(session)}`);
    ctx.writeln(
      "Uses corpus tools (list/read/search). Commands: /grade, /exit",
    );
    ctx.writeln("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.writeln(`Cannot start chat: ${message}`);
    return;
  }

  const history: ChatMessage[] = [];

  if (initialMessage) {
    await sendAndPrint(ctx, session, history, initialMessage);
  }

  while (true) {
    const line = (await ctx.ask("you> ")).trim();
    if (line === "/exit" || line === "/quit") {
      ctx.writeln("Leaving chat.");
      break;
    }
    if (line === "/grade") {
      await gradeLastExchange(ctx, history);
      continue;
    }
    if (!line) continue;
    await sendAndPrint(ctx, session, history, line);
  }
}
