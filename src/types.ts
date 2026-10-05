import { z } from "zod";

/* ------------------------------------------------------------------ *
 * Evaluator identity
 *
 * The evaluator is a measuring instrument. These six components are the
 * only things that go into its identity hash. Change any one of them and
 * every score taken before the change means something different from
 * every score taken after it.
 * ------------------------------------------------------------------ */

/**
 * Decoding parameters passed to the judge model. Part of evaluator identity.
 *
 * Optional fields follow one rule: absent means the parameter is not sent and
 * the provider default applies. An absent key and a present key hash
 * differently (canonicalJson keeps only present keys), so "we stopped pinning
 * temperature" is an identity change, as it should be.
 *
 * `reasoning_effort` uses OpenAI's effort names; the Anthropic path maps them
 * to an extended-thinking token budget in provider-chat.ts. Effort moves
 * verdicts, so it lives here, inside the hashed config — never as an
 * out-of-band request parameter.
 */
export const DecodingConfigSchema = z.object({
  temperature: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().positive().optional(),
  reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).optional(),
  stop_sequences: z.array(z.string()),
});
export type DecodingConfig = z.infer<typeof DecodingConfigSchema>;

/**
 * The six score-affecting components of the evaluator.
 *
 * `model_id` must be a pinned, dated snapshot id. verify requires the
 * manifest's `resolved_model_id` (what the API reported serving) to hash to
 * the model_id component, so an alias that the API resolves to a different
 * string can never be approved. By design: an alias would reduce the identity
 * to a routing label.
 */
export const EvaluatorConfigSchema = z.object({
  /** Contents of rubric/rubric.yaml, through normalizeBlob. */
  rubric: z.string(),
  /** Judge prompt template through normalizeBlob, placeholders unsubstituted. */
  judge_prompt_template: z.string(),
  /**
   * Pinned, dated snapshot id. Never an alias: verify requires the served
   * model (Manifest.resolved_model_id) to hash to this component.
   */
  model_id: z.string(),
  decoding: DecodingConfigSchema,
  /**
   * schemas/verdict.schema.json as parsed JSON (not its verbatim text). Key
   * order is preserved and hashed: the judge request sends the schema in this
   * order, and OpenAI structured outputs generate properties in schema order.
   */
  output_schema: z.unknown(),
  /**
   * sha256 over the scoring-path sources plus the dependency lockfile.
   * src/corpus-docs.ts is deliberately excluded: the files it selects and the
   * content it loads are captured by corpus_hash, and renderDocuments
   * canonicalizes order and line endings before the judge sees them. Agent, shell,
   * verify, and cli code is excluded so subject-agent edits never move
   * evaluator identity.
   */
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
  /** invalid_judge_output is harness-assigned; a human label never uses it. */
  human_label: VerdictLabelSchema.exclude(["invalid_judge_output"]),
  human_severity: SeveritySchema,
  notes: z.string().optional(),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

/** One corpus/docs file as the judge sees it: filename plus normalized content. */
export interface ReferenceDocument {
  filename: string;
  content: string;
}

/**
 * One case, one run. The manifest keeps every one of these so that
 * aggregate metrics can be recomputed offline rather than trusted.
 */
export const ObservationSchema = z.object({
  case_id: z.string(),
  run_index: z.number().int().nonnegative(),
  /**
   * sha256 of the request body bytes the SDK actually sent, captured at the
   * transport by callOpenAiJudge. verify compares it to
   * requestSha256(buildJudgeRequest(...)) rebuilt from the working tree, so
   * evidence is bound to the request that produced it, not only to the
   * component hashes.
   */
  request_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: VerdictSchema,
  /** Unparsed judge response text, kept for audit and reparsing. */
  raw_judge_response: z.string(),
  /**
   * Response metadata, so a refusal and a truncation (both with empty
   * raw_judge_response) stay distinguishable in the audit trail.
   */
  response: z.object({
    id: z.string(),
    finish_reason: z.string().nullable(),
    refusal: z.string().nullable(),
  }),
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

/** The committed gate: validation/thresholds.json. */
export const ThresholdsFileSchema = z.object({
  rationale: z.string().min(1),
  /**
   * Repeats per case that promotable evidence must have. Pinned, not an
   * operator choice: fewer repeats make self_consistency and the zero
   * critical-miss bound easier to meet.
   */
  runs: z.number().int().min(2),
  thresholds: z.array(ThresholdSchema).min(1),
});
export type ThresholdsFile = z.infer<typeof ThresholdsFileSchema>;

export const ManifestSchema = z.object({
  evaluator_id: z.string(),
  /**
   * Per-component hashes behind evaluator_id, so verify can name which of the
   * six components moved. evaluator_id must equal their combination.
   */
  evaluator_components: z.strictObject({
    rubric: z.string(),
    judge_prompt_template: z.string(),
    model_id: z.string(),
    decoding: z.string(),
    output_schema: z.string(),
    implementation_digest: z.string(),
  }),
  corpus_hash: z.string(),
  /**
   * What the API reported serving, recorded from the response. Must equal the
   * configured model_id (checked by verify).
   */
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
    | "request_mismatch"
    | "results_mismatch"
    | "threshold_violation"
    | "manifest_invalid";
  /** The component, metric, or case id this failure names, when it names one. */
  subject?: string;
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
