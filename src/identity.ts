import type { EvaluatorConfig, GoldenCase } from "./types.ts";

/**
 * Hashes the six identity components into one content-addressed evaluator id.
 * Must be canonical: stable key ordering, normalized line endings, no
 * timestamps, no absolute paths. Two checkouts of the same commit on
 * different machines have to produce the same string or the whole scheme
 * is decorative.
 */
export function computeEvaluatorId(_config: EvaluatorConfig): string {
  throw new Error("not implemented");
}

/**
 * Returns the per-component hashes behind an evaluator id, so a mismatch can
 * name which of the six components moved instead of just reporting that the
 * id changed.
 */
export function componentHashes(
  _config: EvaluatorConfig,
): Record<keyof EvaluatorConfig, string> {
  throw new Error("not implemented");
}

/**
 * Hashes the golden set. Order-independent — sorted by case id before
 * hashing — so that reordering cases.jsonl is not treated as changing the
 * corpus, while editing, adding, or removing any case is.
 */
export function computeCorpusHash(_cases: GoldenCase[]): string {
  throw new Error("not implemented");
}

/**
 * sha256 over the scoring module source plus the dependency lockfile. Catches
 * the case where the rubric and prompt are untouched but the code that turns
 * a judge response into a score changed underneath them.
 */
export function computeImplementationDigest(_paths: string[]): string {
  throw new Error("not implemented");
}
