import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EvaluatorConfig,
  GoldenCase,
  ReferenceDocument,
} from "./types.ts";

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
export function normalizeBlob(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) {
    out = out.slice(1);
  }
  return out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function sha256(text: string): string {
  return createHash("sha256").update(normalizeBlob(text), "utf8").digest("hex");
}

/** Stable JSON serialization with sorted object keys at every depth. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`)
    .join(",")}}`;
}

function hashBlob(text: string): string {
  return sha256(normalizeBlob(text));
}

function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

const EVALUATOR_COMPONENT_ORDER: (keyof EvaluatorConfig)[] = [
  "rubric",
  "judge_prompt_template",
  "model_id",
  "decoding",
  "output_schema",
  "implementation_digest",
];

/**
 * Hashes the six identity components into one content-addressed evaluator id.
 * Must be canonical: stable key ordering, every blob through normalizeBlob, no
 * timestamps, no absolute paths. Two checkouts of the same commit on
 * different machines have to produce the same string or the whole scheme
 * is decorative.
 */
export function computeEvaluatorId(config: EvaluatorConfig): string {
  const hashes = componentHashes(config);
  const combined = EVALUATOR_COMPONENT_ORDER
    .map((key) => `${key}:${hashes[key]}`)
    .join("\n");
  return sha256(combined);
}

/**
 * Returns the per-component hashes behind an evaluator id, so a mismatch can
 * name which of the six components moved instead of just reporting that the
 * id changed.
 */
export function componentHashes(
  config: EvaluatorConfig,
): Record<keyof EvaluatorConfig, string> {
  return {
    rubric: hashBlob(config.rubric),
    judge_prompt_template: hashBlob(config.judge_prompt_template),
    model_id: hashBlob(config.model_id),
    decoding: hashJson(config.decoding),
    output_schema: hashJson(config.output_schema),
    implementation_digest: hashBlob(config.implementation_digest),
  };
}

/**
 * Hashes everything the judge grades: the golden set and the reference
 * documents spliced into the prompt. Order-independent — cases sorted by id,
 * documents by filename — so that reordering cases.jsonl or listing docs in a
 * different order is not treated as changing the corpus, while editing,
 * adding, or removing any case or document is.
 *
 * Document content goes through normalizeBlob here rather than trusting the
 * caller: canonicalJson escapes `\r` inside strings, so the final sha256
 * normalization cannot undo a CRLF in content.
 */
export function computeCorpusHash(
  cases: GoldenCase[],
  documents: ReferenceDocument[],
): string {
  const sortedCases = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  const sortedDocuments = documents
    .map((doc) => ({ filename: doc.filename, content: normalizeBlob(doc.content) }))
    // Code-unit order, not localeCompare: the hash must not depend on the
    // machine's ICU locale. Matches listCorpusDocFiles' .sort().
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return sha256(
    canonicalJson({ cases: sortedCases, documents: sortedDocuments }),
  );
}

/**
 * sha256 over the scoring-path sources plus the dependency lockfile. Catches
 * the case where the rubric and prompt are untouched but the code that turns
 * a judge response into a score changed underneath them.
 *
 * Scoring path only (IMPLEMENTATION_DIGEST_PATHS in config.ts).
 * src/corpus-docs.ts is deliberately excluded: its effect on judge input is
 * already captured by corpus_hash over the loaded doc content. Agent, shell,
 * verify, and cli code is excluded so subject-agent edits never move
 * evaluator identity.
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
export function computeImplementationDigest(
  root: string,
  relativePaths: string[],
): string {
  const sortedPaths = [...relativePaths].sort();
  const parts = sortedPaths.map((rel) => {
    const content = readFileSync(join(root, rel), "utf8");
    return `${rel}\n${normalizeBlob(content)}`;
  });
  return sha256(parts.join("\n---\n"));
}
