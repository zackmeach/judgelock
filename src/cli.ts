#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadCorpus, loadEvaluatorRuntimeConfig } from "./config.ts";
import { loadEnvFile } from "./env-file.ts";
import { renderReport, thresholdRows, verdictLine } from "./report.ts";
import type { Manifest } from "./types.ts";
import { CASES_PATH, validate } from "./validate.ts";
import { formatVerifyResult, verify } from "./verify.ts";
import { runShell } from "./shell/repl.ts";

const USAGE = `judgelock <command> [options]

Commands:
  shell      Interactive terminal (default when no command is given)
  verify     Offline drift check. No network. Exits nonzero on any mismatch.
  validate   Run the golden set against the judge API, write a candidate
             manifest and a Markdown report under validation/reports/.
             Manual dispatch only; never touches the approved manifest.
             Reads OPENAI_API_KEY from the environment or <root>/.env.

Options:
  --root <dir>   Repository root. Default: .
  --runs <n>     validate only. Repeats per case, integer >= 1. Default: 1
                 The thresholds require self_consistency, which needs >= 2.
  --out <path>   validate only. Candidate manifest path, relative to --root.
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
    loadEnvFile(root);
    const runs = Number(values.runs);
    let manifest: Manifest;
    try {
      manifest = await validate({
        root,
        runs,
        onObservation: (o, done, total) =>
          console.error(`[${done}/${total}] ${o.case_id} run ${o.run_index}: ${o.verdict.label}`),
      });
    } catch (err) {
      console.error(`judgelock validate: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const generatedAt = new Date();
    const stamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const outPath = resolve(root, values.out ?? "validation/candidate-manifest.json");
    const reportPath = resolve(
      root,
      "validation",
      "reports",
      `${stamp}-${manifest.evaluator_id.slice(0, 12)}.md`,
    );
    const report = renderReport({
      manifest,
      cases: loadCorpus(join(root, CASES_PATH)),
      runs,
      configuredModelId: loadEvaluatorRuntimeConfig(root).model_id,
      generatedAt,
    });
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);

    const rows = thresholdRows(manifest);
    console.log(`candidate manifest: ${outPath}`);
    console.log(`report: ${reportPath}`);
    for (const r of rows) {
      const value = r.value === undefined ? "absent" : String(r.value);
      console.log(
        `${r.pass ? "PASS" : "FAIL"} ${r.threshold.metric} = ${value} (${r.threshold.direction} ${r.threshold.bound})`,
      );
    }
    console.log(verdictLine(rows));
    break;
  }
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
