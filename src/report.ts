import type { GoldenCase, Manifest, Observation, Threshold, VerifyFailure } from "./types.ts";
import { checkRuns, checkThresholds } from "./verify.ts";

/** Measured and shown, never gated: no threshold applies to these. */
const REPORT_ONLY_METRICS = ["false_pass_rate", "severity_agreement"];

export interface ReportInput {
  manifest: Manifest;
  cases: GoldenCase[];
  runs: number;
  /** validation/thresholds.json runs: the only promotable runs per case. */
  requiredRuns: number;
  configuredModelId: string;
  generatedAt: Date;
  /** sha256 of the exact candidate manifest bytes this report describes. */
  candidateSha256: string;
}

export interface ThresholdRow {
  threshold: Threshold;
  value: number | undefined;
  pass: boolean;
}

/** One row per threshold, judged by verify's own checkThresholds. */
export function thresholdRows(manifest: Manifest): ThresholdRow[] {
  return manifest.thresholds.map((threshold) => ({
    threshold,
    value: Object.hasOwn(manifest.results, threshold.metric)
      ? manifest.results[threshold.metric]
      : undefined,
    pass: checkThresholds(manifest.results, [threshold]).length === 0,
  }));
}

/** Eligible only when every threshold passes and checkRuns found nothing. */
export function verdictLine(rows: ThresholdRow[], runProblems: VerifyFailure[]): string {
  const failed = rows.filter((r) => !r.pass).length;
  const reasons = [
    ...(failed > 0 ? [`fails ${failed} threshold(s)`] : []),
    ...runProblems.map((p) => p.detail),
  ];
  return reasons.length === 0
    ? "meets every threshold — eligible for promotion"
    : `${reasons.join("; ")} — do not promote`;
}

/**
 * One Markdown table cell: whitespace collapsed, truncated, backslashes then
 * pipes escaped, `<` escaped so raw judge text cannot render as HTML.
 */
function cell(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return "(empty)";
  const cut = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return cut.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["None."];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

/** Renders a candidate manifest as the Markdown report a reviewer reads before promotion. */
export function renderReport({
  manifest,
  cases,
  runs,
  requiredRuns,
  configuredModelId,
  generatedAt,
  candidateSha256,
}: ReportInput): string {
  const labels = (obs: Observation[]): string => obs.map((o) => o.verdict.label).join(", ");

  const disagreements: string[][] = [];
  const splits: string[][] = [];
  for (const c of cases) {
    const obs = manifest.raw_observations
      .filter((o) => o.case_id === c.id)
      .sort((a, b) => a.run_index - b.run_index);
    const human = `${c.human_label} / ${c.human_severity}`;
    const first = obs.find((o) => o.verdict.label !== c.human_label);
    if (first) {
      disagreements.push([cell(c.id), human, labels(obs), cell(first.verdict.evidence)]);
    }
    if (new Set(obs.map((o) => o.verdict.label)).size > 1) {
      splits.push([cell(c.id), human, labels(obs)]);
    }
  }
  const invalid = manifest.raw_observations
    .filter((o) => o.verdict.label === "invalid_judge_output")
    .map((o) => [cell(o.case_id), String(o.run_index), cell(o.raw_judge_response)]);

  const rows = thresholdRows(manifest);
  return [
    "# Validation report",
    "",
    `Generated ${generatedAt.toISOString()}.`,
    "",
    `- candidate sha256: \`${candidateSha256}\``,
    `- evaluator_id: \`${manifest.evaluator_id}\``,
    `- corpus_hash: \`${manifest.corpus_hash}\``,
    `- model: configured \`${configuredModelId}\`, resolved \`${manifest.resolved_model_id}\``,
    `- runs per case: ${runs}`,
    `- cases: ${cases.length}`,
    `- observations: ${manifest.raw_observations.length}`,
    "",
    "## Evaluator components",
    "",
    ...table(
      ["component", "sha256"],
      Object.entries(manifest.evaluator_components).map(([k, v]) => [k, `\`${v}\``]),
    ),
    "",
    "## Thresholds",
    "",
    ...table(
      ["metric", "value", "bound", "result"],
      rows.map((r) => [
        r.threshold.metric,
        r.value === undefined ? "absent" : String(r.value),
        `${r.threshold.direction} ${r.threshold.bound}`,
        r.pass ? "PASS" : "FAIL",
      ]),
    ),
    "",
    `**Verdict:** ${verdictLine(rows, checkRuns(manifest.raw_observations, requiredRuns))}.`,
    "",
    "## Report-only metrics",
    "",
    "Measured, not gated: no threshold applies.",
    "",
    ...table(
      ["metric", "value"],
      REPORT_ONLY_METRICS.map((name) => [
        name,
        Object.hasOwn(manifest.results, name) ? String(manifest.results[name]) : "absent",
      ]),
    ),
    "",
    "## Disagreements",
    "",
    ...table(["case", "human", "judge per run", "evidence (first disagreeing run)"], disagreements),
    "",
    "## Split verdicts",
    "",
    ...table(["case", "human", "judge per run"], splits),
    "",
    "## Invalid judge outputs",
    "",
    ...table(["case", "run", "raw response"], invalid),
    "",
  ].join("\n");
}
