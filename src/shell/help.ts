export const SHELL_HELP = `
Commands:
  help              Show this message
  exit, quit        Leave the shell

  keys              Show API key status
  keys set <name>   Set a key (openai | anthropic); prompts if value omitted
  keys test         Smoke-test configured API keys

  test              List available tests (placeholder)
  test keys         Run API key smoke tests
  test api          API integration tests (placeholder)
  test unit         Unit tests (placeholder)

  chat [message]    Talk to the configured evaluator model
                    (evaluator.config.json). Interactive when no message given.

  clear             Clear the screen
  status            Show shell status
`.trim();
