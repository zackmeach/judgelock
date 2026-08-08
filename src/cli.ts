#!/usr/bin/env node
import { parseArgs } from "node:util";
import { validate } from "./validate.ts";
import { formatVerifyResult, verify } from "./verify.ts";
import { runShell } from "./shell/repl.ts";

const USAGE = `judgelock <command> [options]

Commands:
  shell      Interactive terminal (default when no command is given)
  verify     Offline drift check. No network. Exits nonzero on any mismatch.
  validate   Run the golden set against the judge API and write a candidate
             manifest. Manual dispatch only; never touches the approved manifest.

Options:
  --root <dir>   Repository root. Default: .
  --runs <n>     validate only. Repeats per case. Default: 1
  --out <path>   validate only. Candidate manifest path.
                 Default: validation/candidate-manifest.json
  -h, --help     Show this message.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    runs: { type: "string", default: "1" },
    out: { type: "string", default: "validation/candidate-manifest.json" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const command = positionals[0] ?? "shell";
const root = values.root ?? ".";

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

switch (command) {
  case "shell": {
    await runShell(root);
    break;
  }
  case "verify": {
    const result = verify({ root });
    console.log(formatVerifyResult(result));
    process.exit(result.ok ? 0 : 1);
  }
  case "validate": {
    const manifest = await validate({
      root,
      runs: Number(values.runs ?? "1"),
      out: values.out ?? "validation/candidate-manifest.json",
    });
    console.log(
      `wrote candidate manifest with ${manifest.raw_observations.length} observations`,
    );
    break;
  }
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
