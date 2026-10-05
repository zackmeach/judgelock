import { THRESHOLDS_PATH } from "./config.ts";
import {
  compareCodeUnits,
  componentHashes,
  computeCorpusHash,
  computeEvaluatorId,
} from "./identity.ts";
import {
  ManifestSchema,
  type EvaluatorConfig,
  type GoldenCase,
  type Manifest,
  type Observation,
  type ReferenceDocument,
  type Results,
  type ThresholdsFile,
  type VerdictLabel,
} from "./types.ts";

export interface ValidateOptions {
  root: string;
  /** Repeat count per case. >1 is what makes judge self-consistency measurable. */
  runs: number;
  /** Where the candidate manifest is written. Never the approved manifest. */
  out: string;
}

/** One way a set of observations fails to cover the golden set exactly. */
export interface CoverageProblem {
  case_id: string;
  detail: string;
}

/**
 * Checks that observations cover the golden set exactly: every observation
 * names a known case, every case has observations, each case's run indices are
 * exactly 0..n-1 with no duplicates, and every case has the same run count.
 * Metrics over anything less would silently describe a different corpus.
 */
export function checkCoverage(
  observations: Observation[],
  cases: GoldenCase[],
): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const runs = new Map<string, number[]>(cases.map((c) => [c.id, []]));
  const unknown = new Set<string>();
  for (const o of observations) {
    const indices = runs.get(o.case_id);
    if (indices) indices.push(o.run_index);
    else unknown.add(o.case_id);
  }
  for (const id of unknown) {
    problems.push({ case_id: id, detail: `observation for unknown case ${id}` });
  }

  let most: { id: string; count: number } | undefined;
  for (const [id, indices] of runs) {
    if (indices.length === 0) {
      problems.push({ case_id: id, detail: `case ${id} has no observations` });
      continue;
    }
    const sorted = [...indices].sort((a, b) => a - b);
    const duplicates = new Set(sorted.filter((v, i) => v === sorted[i - 1]));
    for (const index of duplicates) {
      problems.push({ case_id: id, detail: `case ${id} has duplicate run_index ${index}` });
    }
    const distinct = [...new Set(sorted)];
    if (distinct.some((v, i) => v !== i)) {
      problems.push({
        case_id: id,
        detail: `case ${id} has run indices [${distinct.join(", ")}], expected 0..${distinct.length - 1}`,
      });
    }
    if (!most || indices.length > most.count) most = { id, count: indices.length };
  }

  for (const [id, indices] of runs) {
    if (most && indices.length > 0 && indices.length < most.count) {
      problems.push({
        case_id: id,
        detail: `case ${id} has ${indices.length} runs but case ${most.id} has ${most.count}`,
      });
    }
  }
  return problems;
}

/**
 * Computes the aggregate metrics from raw observations. Shared with verify —
 * verify recomputes with this exact function, so a manifest whose stated
 * results disagree with its own raw observations is caught rather than
 * believed.
 *
 * Assumes checkCoverage is clean; throws on an observation for an unknown
 * case. A metric whose denominator is zero is omitted, not reported as 0 —
 * and a threshold on an omitted metric fails.
 *
 * - agreement: observations whose label equals the case's human label.
 * - critical_miss_rate: among observations of critical non-pass cases, the
 *   fraction the judge labeled pass.
 * - invalid_output_rate: observations labeled invalid_judge_output.
 * - self_consistency: only when every case has at least 2 observations; the
 *   fraction of cases whose observations all share one label.
 */
export function computeResults(
  observations: Observation[],
  cases: GoldenCase[],
): Results {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const labelsByCase = new Map<string, VerdictLabel[]>();
  let agreed = 0;
  let invalid = 0;
  let critical = 0;
  let criticalMissed = 0;

  for (const o of observations) {
    const c = byId.get(o.case_id);
    if (!c) throw new Error(`observation for unknown case ${o.case_id}`);
    const label = o.verdict.label;
    if (label === c.human_label) agreed++;
    if (label === "invalid_judge_output") invalid++;
    if (c.human_label !== "pass" && c.human_severity === "critical") {
      critical++;
      if (label === "pass") criticalMissed++;
    }
    const labels = labelsByCase.get(c.id) ?? [];
    labels.push(label);
    labelsByCase.set(c.id, labels);
  }

  const results: Results = {};
  const n = observations.length;
  if (n > 0) results.agreement = agreed / n;
  if (critical > 0) results.critical_miss_rate = criticalMissed / critical;
  if (n > 0) results.invalid_output_rate = invalid / n;
  if (
    cases.length > 0 &&
    cases.every((c) => (labelsByCase.get(c.id)?.length ?? 0) >= 2)
  ) {
    const consistent = cases.filter(
      (c) => new Set(labelsByCase.get(c.id)).size === 1,
    ).length;
    results.self_consistency = consistent / cases.length;
  }
  return results;
}

export interface BuildManifestInput {
  config: EvaluatorConfig;
  cases: GoldenCase[];
  documents: ReferenceDocument[];
  observations: Observation[];
  resolvedModelId: string;
  thresholds: ThresholdsFile;
}

/**
 * Assembles a manifest from already-collected observations. Pure: no I/O, no
 * API calls. Throws if the observations do not cover the cases exactly.
 */
export function buildManifest(input: BuildManifestInput): Manifest {
  const problems = checkCoverage(input.observations, input.cases);
  if (problems.length > 0) {
    throw new Error(
      `observations do not cover the corpus:\n${problems.map((p) => `  ${p.detail}`).join("\n")}`,
    );
  }
  const observations = [...input.observations].sort(
    (a, b) => compareCodeUnits(a.case_id, b.case_id) || a.run_index - b.run_index,
  );
  return ManifestSchema.parse({
    evaluator_id: computeEvaluatorId(input.config),
    evaluator_components: componentHashes(input.config),
    corpus_hash: computeCorpusHash(input.cases, input.documents),
    resolved_model_id: input.resolvedModelId,
    raw_observations: observations,
    results: computeResults(observations, input.cases),
    thresholds: input.thresholds.thresholds,
    threshold_source: THRESHOLDS_PATH,
  });
}

/**
 * Makes real judge API calls across the golden set and writes a *candidate*
 * manifest plus a human-readable report under validation/reports/. Manual
 * dispatch only. Never writes to validation/approved-manifest.json —
 * promoting a candidate to approved is a human act, reviewed in a PR.
 */
export async function validate(_opts: ValidateOptions): Promise<Manifest> {
  throw new Error("not implemented");
}
