import type { EvaluatorConfig, GoldenCase, Manifest } from "./types.ts";

/**
 * Reads the six identity components off disk — rubric/rubric.yaml, the judge
 * prompt template, the configured model id and decoding config, and
 * schemas/verdict.schema.json — and computes the implementation digest over
 * the scoring module plus the lockfile. Validates against EvaluatorConfigSchema.
 * Throws rather than defaulting: a missing component is a broken evaluator,
 * not a zero value.
 */
export function loadEvaluatorConfig(_root: string): EvaluatorConfig {
  throw new Error("not implemented");
}

/**
 * Parses corpus/cases.jsonl one line at a time, validating each row against
 * GoldenCaseSchema. Rejects duplicate case ids — the corpus hash is only
 * meaningful if ids are unique.
 */
export function loadCorpus(_path: string): GoldenCase[] {
  throw new Error("not implemented");
}

/**
 * Reads validation/approved-manifest.json and validates it against
 * ManifestSchema. This is the approved evidence; verify compares against it
 * and never writes to it.
 */
export function loadApprovedManifest(_path: string): Manifest {
  throw new Error("not implemented");
}

/**
 * Reads evaluator.lock.json — the recorded evaluator identity and the
 * per-component hashes that let a mismatch be attributed to a specific
 * component rather than reported as an opaque id change.
 */
export function loadLockfile(_path: string): Record<string, string | null> {
  throw new Error("not implemented");
}
