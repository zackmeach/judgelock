#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import {
  APPROVED_MANIFEST_PATH,
  CASES_PATH,
  THRESHOLDS_PATH,
  loadCorpus,
  loadEvaluatorRuntimeConfig,
  loadThresholds,
} from "./config.ts";
import { loadEnvFile } from "./env-file.ts";
import { renderReport, thresholdRows, verdictLine } from "./report.ts";
import type { Manifest } from "./types.ts";
import { serializeManifest, validate } from "./validate.ts";
import { checkRuns, formatVerifyResult, verify } from "./verify.ts";

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
  --runs <n>     validate only. Repeats per case, 1 to 10. Default: the runs
                 pinned in validation/thresholds.json, the only promotable count.
  --out <path>   validate only. Candidate manifest path, relative to --root.
                 Default: validation/candidate-manifest.json
                 Must be a .json file in an existing directory inside
                 validation/, not a link and not reached through one, and not
                 validation/approved-manifest.json or validation/thresholds.json.
  -h, --help     Show this message.
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: "." },
    runs: { type: "string" },
    out: { type: "string", default: "validation/candidate-manifest.json" },
    help: { type: "boolean", short: "h", default: false },
  },
});

/** Case-insensitive where the default filesystem is. */
const fold = (p: string): string =>
  process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p;

/** True when `p` is `dir` or inside it. */
const within = (dir: string, p: string): boolean => {
  const rel = relative(fold(dir), fold(p));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/**
 * Why --out is refused, or undefined. Lexical checks, then the filesystem: a
 * symlink or junction under validation/ must not redirect the write onto the
 * approved manifest, the thresholds, or anything outside validation/.
 * ponytail: checked once before the run, not at write time; a link swapped
 * in during the run is not caught.
 */
function outProblem(root: string, out: string): string | undefined {
  const outPath = resolve(root, out);
  const validationDir = resolve(root, "validation");
  const reserved = [APPROVED_MANIFEST_PATH, THRESHOLDS_PATH].map((p) => resolve(root, p));
  const reservedMessage = `--out must not be ${APPROVED_MANIFEST_PATH} or ${THRESHOLDS_PATH}; promotion is a reviewed copy in a PR`;
  if (!within(validationDir, outPath) || !fold(outPath).endsWith(".json")) {
    return `--out must be a .json file inside validation/, got ${JSON.stringify(out)}`;
  }
  if (reserved.some((p) => fold(p) === fold(outPath))) return reservedMessage;
  if (process.platform === "win32" && basename(outPath).includes(":")) {
    return `--out must not contain ":" in its file name (an NTFS alternate data stream), got ${JSON.stringify(out)}`;
  }
  if (lstatSync(outPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return `--out must not be a symbolic link or junction, got ${JSON.stringify(out)}`;
  }
  if (!existsSync(validationDir) || !existsSync(dirname(outPath))) {
    return `--out must be in an existing directory under validation/, got ${JSON.stringify(out)}`;
  }
  const realValidation = realpathSync(validationDir);
  const realOut = join(realpathSync(dirname(outPath)), basename(outPath));
  if (!within(realValidation, realOut)) {
    return `--out must not leave validation/ through a link: ${JSON.stringify(out)} resolves to ${JSON.stringify(realOut)}`;
  }
  const realReserved = reserved.map((p) =>
    existsSync(p) ? realpathSync(p) : join(realValidation, basename(p)),
  );
  if (realReserved.some((p) => fold(p) === fold(realOut))) return reservedMessage;
  return undefined;
}

const command = positionals[0] ?? "shell";
const root = values.root ?? ".";

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

switch (command) {
  case "shell": {
    // Lazy: verify and validate never load shell or agent modules.
    const { runShell } = await import("./shell/repl.ts");
    await runShell(root);
    break;
  }
  case "verify": {
    const result = verify({ root });
    console.log(formatVerifyResult(result));
    process.exit(result.ok ? 0 : 1);
  }
  case "validate": {
    // Failure paths set exitCode and break rather than process.exit: SDK
    // sockets may still be open, and exiting under them aborts on Windows.
    const out = values.out ?? "validation/candidate-manifest.json";
    const outPath = resolve(root, out);
    const problem = outProblem(root, out);
    if (problem !== undefined) {
      console.error(`judgelock validate: ${problem}`);
      process.exitCode = 1;
      break;
    }
    // ponytail: cap guards a typo'd 10x spend; raise if a larger
    // self-consistency sample is wanted.
    const MAX_RUNS = 10;
    const requiredRuns = loadThresholds(root).runs;
    const runsArg = values.runs ?? String(requiredRuns);
    if (!/^[1-9]\d*$/.test(runsArg) || Number(runsArg) > MAX_RUNS) {
      console.error(
        `judgelock validate: --runs must be an integer from 1 to ${MAX_RUNS}, got ${JSON.stringify(runsArg)}`,
      );
      process.exitCode = 1;
      break;
    }
    const runs = Number(runsArg);

    loadEnvFile(root);
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
      process.exitCode = 1;
      break;
    }

    const candidate = serializeManifest(manifest);
    const candidateSha256 = createHash("sha256").update(candidate, "utf8").digest("hex");
    const generatedAt = new Date();
    const stamp = generatedAt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
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
      requiredRuns,
      configuredModelId: loadEvaluatorRuntimeConfig(root).model_id,
      generatedAt,
      candidateSha256,
    });
    // Report first: a candidate never exists without the report that describes it.
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, report);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, candidate);

    const rows = thresholdRows(manifest);
    console.log(`candidate manifest: ${outPath}`);
    console.log(`candidate sha256: ${candidateSha256}`);
    console.log(`report: ${reportPath}`);
    for (const r of rows) {
      const value = r.value === undefined ? "absent" : String(r.value);
      console.log(
        `${r.pass ? "PASS" : "FAIL"} ${r.threshold.metric} = ${value} (${r.threshold.direction} ${r.threshold.bound})`,
      );
    }
    console.log(verdictLine(rows, checkRuns(manifest.raw_observations, requiredRuns)));
    break;
  }
  default:
    console.error(`unknown command: ${command}\n\n${USAGE}`);
    process.exit(1);
}
