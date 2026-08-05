import type { EvaluatorConfig, GoldenCase } from "./types.ts";

/**
 * Canonicalizes a blob before it is hashed: CRLF and lone CR to LF, UTF-8 BOM
 * stripped. Every string feeding an identity component goes through this —
 * rubric, prompt template, output schema — because identical content must hash
 * identically no matter how it reached the disk.
 *
 * .gitattributes sets `eol=lf`, but that governs only files arriving through a
 * checkout of this repo. A pasted rubric, a contributor with a mangled
 * core.autocrlf, or a file fetched by any other route never passes through it.
 * This function is the mechanism; .gitattributes is defense in depth.
 */
export function normalizeBlob(_text: string): string {
  throw new Error("not implemented");
}

/**
 * Hashes the six identity components into one content-addressed evaluator id.
 * Must be canonical: stable key ordering, every blob through normalizeBlob, no
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
 *
 * Hashes the .ts sources under src/, never the built dist/ output. This is
 * settled, not a preference: the .ts files are what the repo stores, what a
 * reviewer reads, and what a mutation test edits. dist/ is derived, gitignored,
 * and absent in CI. It also closes the seam — `verify` executes these same .ts
 * files via Node's type stripping, so the bytes that are digested are the bytes
 * that run. Digesting a transformed artifact would break that equality.
 *
 * Blobs go through normalizeBlob before hashing.
 */
export function computeImplementationDigest(_paths: string[]): string {
  throw new Error("not implemented");
}
