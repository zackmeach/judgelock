import { runApiKeyTests, formatApiKeyStatusBlock } from "../api-key-test.ts";
import {
  loadEnvFile,
  resolveProviderEnvKey,
  setEnvKey,
} from "../env-file.ts";
import { runChatSession } from "./chat-session.ts";
import { SHELL_HELP } from "./help.ts";

export interface ShellContext {
  root: string;
  ask: (prompt: string) => Promise<string>;
  write: (text: string) => void;
  writeln: (text: string) => void;
}

export async function handleKeys(
  ctx: ShellContext,
  args: string[],
): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub) {
    loadEnvFile(ctx.root);
    ctx.writeln("API keys:");
    ctx.writeln(formatApiKeyStatusBlock());
    return;
  }

  if (sub === "test") {
    await handleTestKeys(ctx);
    return;
  }

  if (sub === "set") {
    const provider = args[1]?.toLowerCase();
    if (!provider) {
      ctx.writeln("Usage: keys set <openai|anthropic> [value]");
      return;
    }

    const envKey = resolveProviderEnvKey(provider);
    if (!envKey) {
      ctx.writeln(`Unknown provider "${provider}". Use openai or anthropic.`);
      return;
    }

    let value = args.slice(2).join(" ").trim();
    if (!value) {
      ctx.writeln(
        `Paste ${envKey} (input is visible). Leave blank to cancel.`,
      );
      value = (await ctx.ask(`${envKey}> `)).trim();
    }

    if (!value) {
      ctx.writeln("Cancelled.");
      return;
    }

    setEnvKey(ctx.root, envKey, value);
    ctx.writeln(`Saved ${envKey} to .env`);
    return;
  }

  ctx.writeln(`Unknown keys subcommand "${sub}". Try: keys, keys set, keys test`);
}

export async function handleTestKeys(ctx: ShellContext): Promise<void> {
  loadEnvFile(ctx.root);
  ctx.writeln("Running API key smoke tests...");
  ctx.writeln("");

  const result = await runApiKeyTests(ctx.root);
  for (const line of result.lines) {
    ctx.writeln(`${line.provider}: ${line.detail}`);
  }

  if (result.failures.length > 0) {
    ctx.writeln("");
    ctx.writeln(`Failed: ${result.failures.join(", ")}`);
  }
}

export async function handleChat(
  ctx: ShellContext,
  args: string[],
): Promise<void> {
  const initial = args.join(" ").trim();
  await runChatSession(ctx, initial || undefined);
}

export function handleStatus(ctx: ShellContext): void {
  loadEnvFile(ctx.root);
  ctx.writeln(`root: ${ctx.root}`);
  ctx.writeln(formatApiKeyStatusBlock());
}

export function handleHelp(ctx: ShellContext): void {
  ctx.writeln(SHELL_HELP);
}

export function handleClear(ctx: ShellContext): void {
  ctx.write("\x1Bc");
}

export async function dispatchLine(
  ctx: ShellContext,
  line: string,
): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return true;

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";
  const args = parts.slice(1);

  switch (cmd) {
    case "help":
    case "?":
      handleHelp(ctx);
      break;
    case "exit":
    case "quit":
      return false;
    case "keys":
      await handleKeys(ctx, args);
      break;
    case "chat":
      await handleChat(ctx, args);
      break;
    case "status":
      handleStatus(ctx);
      break;
    case "clear":
      handleClear(ctx);
      break;
    default:
      ctx.writeln(`Unknown command: ${cmd}. Type 'help' for commands.`);
  }

  return true;
}
