import {
  describeEvaluatorChat,
  sendEvaluatorChat,
  type ChatMessage,
} from "../evaluator-chat.ts";
import { reloadEnvFile } from "../env-file.ts";
import type { ShellContext } from "./handlers.ts";

async function sendAndPrint(
  ctx: ShellContext,
  history: ChatMessage[],
  userMessage: string,
): Promise<void> {
  try {
    const reply = await sendEvaluatorChat(ctx.root, history, userMessage);
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

export async function runChatSession(
  ctx: ShellContext,
  initialMessage?: string,
): Promise<void> {
  reloadEnvFile(ctx.root);

  try {
    const label = describeEvaluatorChat(ctx.root);
    ctx.writeln(`Chat with evaluator: ${label}`);
    ctx.writeln(
      "Talk to the model configured in evaluator.config.json. Type /exit to return.",
    );
    ctx.writeln("");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.writeln(`Cannot start chat: ${message}`);
    return;
  }

  const history: ChatMessage[] = [];

  if (initialMessage) {
    await sendAndPrint(ctx, history, initialMessage);
  }

  while (true) {
    const line = (await ctx.ask("you> ")).trim();
    if (line === "/exit" || line === "/quit") {
      ctx.writeln("Leaving chat.");
      break;
    }
    if (!line) continue;
    await sendAndPrint(ctx, history, line);
  }
}
