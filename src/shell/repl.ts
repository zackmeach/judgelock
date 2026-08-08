import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { loadEnvFileIntoProcess } from "../env-file.ts";
import { formatApiKeyStatusBlock } from "../api-key-test.ts";
import { dispatchLine, type ShellContext } from "./handlers.ts";

const BANNER = `
  judgelock
  ---------
  Interactive shell. Type 'help' for commands, or 'chat' to talk to the evaluator.
`.trim();

export async function runShell(root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  loadEnvFileIntoProcess(resolvedRoot);

  const rl = createInterface({ input, output, terminal: true });

  const ctx: ShellContext = {
    root: resolvedRoot,
    ask: (prompt) => rl.question(prompt),
    write: (text) => output.write(text),
    writeln: (text) => output.write(`${text}\n`),
  };

  ctx.writeln(BANNER);
  ctx.writeln(`  root: ${resolvedRoot}`);
  ctx.writeln("");
  ctx.writeln(formatApiKeyStatusBlock());
  ctx.writeln("");

  try {
    while (true) {
      const line = await rl.question("judgelock> ");
      const keepGoing = await dispatchLine(ctx, line);
      if (!keepGoing) {
        ctx.writeln("Goodbye.");
        break;
      }
    }
  } finally {
    rl.close();
  }
}
