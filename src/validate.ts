import { join } from "node:path";
import {
  CASES_PATH,
  THRESHOLDS_PATH,
  loadCorpus,
  loadEvaluatorConfig,
  loadEvaluatorRuntimeConfig,
  loadReferenceDocuments,
  loadThresholds,
} from "./config.ts";
import {
  compareCodeUnits,
  componentHashes,
  computeCorpusHash,
  computeEvaluatorId,
} from "./identity.ts";
import { callJudge, parseVerdict, type JudgeResponse } from "./judge.ts";
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

/** One judge call. Tests inject a fake; the default is callJudge. */
export type JudgeFn = typeof callJudge;

export interface ValidateOptions {
  root: string;
  /** Repeat count per case. >1 is what makes judge self-consistency measurable. */
  runs: number;
  /** Default callJudge. */
  judge?: JudgeFn;
  /** Judge calls in flight at once. Default 4. */
  concurrency?: number;
  /** Called once per recorded observation, in completion order. */
  onObservation?: (o: Observation, done: number, total: number) => void;
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
    problems.push({ case_id: id, detail: `observation for unknown case ${JSON.stringify(id)}` });
  }

  let most: { id: string; count: number } | undefined;
  for (const [id, indices] of runs) {
    if (indices.length === 0) {
      problems.push({ case_id: id, detail: `case ${JSON.stringify(id)} has no observations` });
      continue;
    }
    const sorted = [...indices].sort((a, b) => a - b);
    const duplicates = new Set(sorted.filter((v, i) => v === sorted[i - 1]));
    for (const index of duplicates) {
      problems.push({ case_id: id, detail: `case ${JSON.stringify(id)} has duplicate run_index ${index}` });
    }
    const distinct = [...new Set(sorted)];
    if (distinct.some((v, i) => v !== i)) {
      problems.push({
        case_id: id,
        detail: `case ${JSON.stringify(id)} has run indices [${distinct.join(", ")}], expected 0..${distinct.length - 1}`,
      });
    }
    if (!most || indices.length > most.count) most = { id, count: indices.length };
  }

  for (const [id, indices] of runs) {
    if (most && indices.length > 0 && indices.length < most.count) {
      problems.push({
        case_id: id,
        detail: `case ${JSON.stringify(id)} has ${indices.length} runs but case ${JSON.stringify(most.id)} has ${most.count}`,
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

/** Canonical observation order: case_id by code unit, then run_index. */
export function compareObservations(a: Observation, b: Observation): number {
  return compareCodeUnits(a.case_id, b.case_id) || a.run_index - b.run_index;
}

/**
 * The one serialization of a manifest. verify rejects an approved manifest
 * whose text (line endings and BOM aside) is not exactly this, so the text a
 * reviewer reads is the evidence verify enforces.
 */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2) + "\n";
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
  const observations = [...input.observations].sort(compareObservations);
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
 * Runs every golden case `runs` times against the judge and returns the
 * *candidate* manifest. Writes no files: the CLI owns the candidate and
 * report paths, and nothing here ever touches
 * validation/approved-manifest.json — promoting a candidate to approved is a
 * human act, reviewed in a PR.
 *
 * Judge output that does not parse is recorded as invalid_judge_output (a
 * metric, not an error). A judge call that rejects (after the SDK's own
 * retries) aborts the run: no new calls are started, calls already in flight
 * are discarded, and the returned promise rejects naming the case and run.
 * A throwing onObservation aborts the same way. The run also rejects if a
 * response reports no served model, or if the API reported serving more than
 * one model — evidence spanning two models describes neither.
 */
export async function validate(opts: ValidateOptions): Promise<Manifest> {
  // ponytail: fixed pool of 4, no adaptive rate limiting; the OpenAI SDK's
  // built-in retries (2, with backoff) absorb 429s. Add a limiter if a larger
  // golden set hits sustained rate limits.
  const concurrency = opts.concurrency ?? 4;
  for (const [name, value] of [["runs", opts.runs], ["concurrency", concurrency]] as const) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be an integer >= 1, got ${value}`);
    }
  }
  const judge = opts.judge ?? callJudge;
  const config = loadEvaluatorConfig(opts.root);
  const { provider } = loadEvaluatorRuntimeConfig(opts.root);
  const cases = loadCorpus(join(opts.root, CASES_PATH));
  if (cases.length === 0) throw new Error(`${CASES_PATH} has no cases`);
  const documents = loadReferenceDocuments(opts.root);
  const thresholds = loadThresholds(opts.root);

  const jobs = cases.flatMap((testCase) =>
    Array.from({ length: opts.runs }, (_, run_index) => ({ testCase, run_index })),
  );
  const observations: Observation[] = [];
  const resolvedModelIds = new Set<string>();
  let next = 0;
  let failed = false;

  const runJob = async ({ testCase, run_index }: (typeof jobs)[number]): Promise<void> => {
    const where = `case ${testCase.id} run ${run_index}`;
    try {
      let response: JudgeResponse;
      try {
        response = await judge(config, documents, testCase, { provider });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`judge call failed on ${where}: ${message}`, { cause: err });
      }
      if (failed) return;
      if (response.resolved_model_id.trim() === "") {
        throw new Error(`judge API reported no served model on ${where}`);
      }
      resolvedModelIds.add(response.resolved_model_id);
      const observation: Observation = {
        case_id: testCase.id,
        run_index,
        verdict: parseVerdict(response.raw),
        raw_judge_response: response.raw,
      };
      observations.push(observation);
      opts.onObservation?.(observation, observations.length, jobs.length);
    } catch (err) {
      // Any throw, including onObservation's, stops the pool before it propagates.
      failed = true;
      throw err;
    }
  };
  const worker = async (): Promise<void> => {
    while (!failed && next < jobs.length) await runJob(jobs[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const served = [...resolvedModelIds].sort(compareCodeUnits);
  if (served.length !== 1) {
    throw new Error(
      `judge API served more than one model during the run: ${served.map((id) => JSON.stringify(id)).join(", ")}`,
    );
  }
  return buildManifest({
    config,
    cases,
    documents,
    observations,
    resolvedModelId: served[0]!,
    thresholds,
  });
}
