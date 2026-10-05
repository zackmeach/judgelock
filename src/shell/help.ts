export const SHELL_HELP = `
Commands:
  help              Show this message
  exit, quit        Leave the shell

  keys              Show API key status
  keys set <name>   Set a key (openai | anthropic); prompts if value omitted
  keys test         Smoke-test configured API keys

  chat [message]    Talk to the Medicare enrollment agent (corpus tools)
                    /grade judges the last Q&A. /exit leaves chat.

  clear             Clear the screen
  status            Show shell status
`.trim();
