import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Evaluator identity
 *
 * The evaluator is a measuring instrument. These six components are the
 * only things that go into its identity hash. Change any one of them and
 * every score taken before the change means something different from
 * every score taken after it.
 * ------------------------------------------------------------------ */

/** Decoding parameters passed to the judge model. Part of evaluator identity. */
export const DecodingConfigSchema = z.object({
  temperature: z.number().min(0).max(1),
  max_tokens: z.number().int().positive(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  stop_sequences: z.array(z.string()),
});
export type DecodingConfig = z.infer<typeof DecodingConfigSchema>;

/**
 * The six score-affecting components of the evaluator.
 *
 * `model_id` is the *configured* identifier (e.g. an alias). What the API
 * actually served is `Manifest.resolved_model_id` — a different fact,
 * recorded separately, deliberately not part of the identity hash.
 */
export const EvaluatorConfigSchema = z.object({
  /** Verbatim contents of rubric/rubric.yaml. */
  rubric: z.string(),
  /** Verbatim judge prompt template, placeholders unsubstituted. */
  judge_prompt_template: z.string(),
  /** Model identifier as configured, before any server-side resolution. */
  model_id: z.string(),
  decoding: DecodingConfigSchema,
  /** Verbatim contents of schemas/verdict.schema.json. */
  output_schema: z.unknown(),
  /** sha256 over the scoring module source plus the dependency lockfile. */
  implementation_digest: z.string(),
});
export type EvaluatorConfig = z.infer<typeof EvaluatorConfigSchema>;

/* ------------------------------------------------------------------ *
 * Verdicts and observations
 * ------------------------------------------------------------------ */

export const VerdictLabelSchema = z.enum([
  "pass",
  "unsupported",
  "incorrect",
  "incomplete",
  /** The judge returned something that did not conform to the output schema. */
  "invalid_judge_output",
]);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const SeveritySchema = z.enum(["critical", "standard"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const VerdictSchema = z.object({
  label: VerdictLabelSchema,
  severity: SeveritySchema,
  /** Free text: the span or claim the judge based this verdict on. */
  evidence: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** One golden-set case with its human label. */
export const GoldenCaseSchema = z.object({
  id: z.string(),
  question: z.string(),
  /** The model output being graded. */
  answer: z.string(),
  human_label: VerdictLabelSchema,
  human_severity: SeveritySchema,
  notes: z.string().optional(),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/**
 * One case, one run. The manifest keeps every one of these so that
 * aggregate metrics can be recomputed offline rather than trusted.
 */
export const ObservationSchema = z.object({
  case_id: z.string(),
  run_index: z.number().int().nonnegative(),
  verdict: VerdictSchema,
  /** Unparsed judge response text, kept for audit and reparsing. */
  raw_judge_response: z.string(),
});
export type Observation = z.infer<typeof ObservationSchema>;

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

/** Metric name -> value. Recomputed from raw_observations, never trusted as written. */
export const ResultsSchema = z.record(z.string(), z.number());
export type Results = z.infer<typeof ResultsSchema>;

/**
 * A gate on one metric. `direction` says whether `bound` is a floor or a
 * ceiling, so verify can compare without knowing what the metric means.
 */
export const ThresholdSchema = z.object({
  metric: z.string(),
  direction: z.enum(["min", "max"]),
  bound: z.number(),
});
export type Threshold = z.infer<typeof ThresholdSchema>;

export const ManifestSchema = z.object({
  evaluator_id: z.string(),
  corpus_hash: z.string(),
  /** What the API reported serving, as distinct from the configured model_id. */
  resolved_model_id: z.string(),
  raw_observations: z.array(ObservationSchema),
  results: ResultsSchema,
  thresholds: z.array(ThresholdSchema),
  /**
   * Provenance of the threshold values — path or URL to the artifact that
   * justified them. Exists so thresholds cannot be quietly fitted to results
   * after the fact.
   */
  threshold_source: z.string(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/* ------------------------------------------------------------------ *
 * Command results
 * ------------------------------------------------------------------ */

/** One reason verify failed, phrased for a CI log. */
export interface VerifyFailure {
  kind:
    | "evaluator_id_mismatch"
    | "corpus_hash_mismatch"
    | "results_mismatch"
    | "threshold_violation"
    | "manifest_invalid";
  detail: string;
  expected?: string;
  actual?: string;
}

export interface VerifyResult {
  ok: boolean;
  evaluator_id: string;
  corpus_hash: string;
  failures: VerifyFailure[];
}
