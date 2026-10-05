import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { listCorpusDocFiles, readCorpusDocument } from "./corpus-docs.ts";
import { computeImplementationDigest, normalizeBlob } from "./identity.ts";
import {
  DecodingConfigSchema,
  EvaluatorConfigSchema,
  GoldenCaseSchema,
  type EvaluatorConfig,
  type GoldenCase,
  type ReferenceDocument,
} from "./types.ts";

const RUBRIC_PATH = "rubric/rubric.yaml";
const PROMPT_PATH = "prompts/judge.txt";
const CONFIG_PATH = "evaluator.config.json";
const AGENT_CONFIG_PATH = "agent.config.json";
const SCHEMA_PATH = "schemas/verdict.schema.json";

/**
 * Files behind implementation_digest: the scoring path plus the lockfile.
 * src/corpus-docs.ts is deliberately excluded — the files it selects and the
 * content it loads are captured by corpus_hash, and renderDocuments
 * canonicalizes order and line endings before the judge sees them. Agent,
 * shell, verify, and cli code is excluded so subject-agent edits never move
 * evaluator identity. A missing file throws.
 */
export const IMPLEMENTATION_DIGEST_PATHS = Object.freeze([
  "src/config.ts",
  "src/identity.ts",
  "src/judge.ts",
  "src/types.ts",
  "src/validate.ts",
  "package-lock.json",
]) as readonly string[];

export const ProviderSchema = z.enum(["openai", "anthropic"]);
export type Provider = z.infer<typeof ProviderSchema>;

export const EvaluatorRuntimeConfigSchema = z.object({
  provider: ProviderSchema,
  model_id: z.string(),
  decoding: DecodingConfigSchema,
});
export type EvaluatorRuntimeConfig = z.infer<typeof EvaluatorRuntimeConfigSchema>;

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

function readJson(path: string): unknown {
  return JSON.parse(readUtf8(path));
}

/**
 * Runtime wiring for judge API calls — provider and the configured model/decoding.
 * Not part of the evaluator identity hash; switching providers with the same
 * model_id string would not change evaluator_id (model_id is still hashed).
 */
export function loadEvaluatorRuntimeConfig(root: string): EvaluatorRuntimeConfig {
  const raw = readJson(join(root, CONFIG_PATH));
  return EvaluatorRuntimeConfigSchema.parse(raw);
}

/**
 * Runtime wiring for the subject agent — the system under evaluation, a
 * different instrument from the judge. Its own file so that changing the
 * agent's model or decoding can never move the evaluator identity, and
 * vice versa.
 */
export function loadAgentRuntimeConfig(root: string): EvaluatorRuntimeConfig {
  const raw = readJson(join(root, AGENT_CONFIG_PATH));
  return EvaluatorRuntimeConfigSchema.parse(raw);
}

/**
 * Reads the six identity components off disk — rubric/rubric.yaml, the judge
 * prompt template, the configured model id and decoding config, and
 * schemas/verdict.schema.json — and computes the implementation digest over
 * IMPLEMENTATION_DIGEST_PATHS (scoring path only, plus the lockfile).
 * Validates against EvaluatorConfigSchema. Throws rather than defaulting: a
 * missing component is a broken evaluator, not a zero value.
 */
export function loadEvaluatorConfig(root: string): EvaluatorConfig {
  // Normalized here, not only when hashed, so the prompt the judge sees is the
  // same bytes on a CRLF or BOM checkout as on the one the id was approved on.
  const rubric = normalizeBlob(readUtf8(join(root, RUBRIC_PATH)));
  const judge_prompt_template = normalizeBlob(readUtf8(join(root, PROMPT_PATH)));
  const runtime = loadEvaluatorRuntimeConfig(root);
  const output_schema = readJson(join(root, SCHEMA_PATH));

  const implementation_digest = computeImplementationDigest(
    root,
    IMPLEMENTATION_DIGEST_PATHS,
  );

  return EvaluatorConfigSchema.parse({
    rubric,
    judge_prompt_template,
    model_id: runtime.model_id,
    decoding: runtime.decoding,
    output_schema,
    implementation_digest,
  });
}

/**
 * Loads every corpus/docs/*.md, sorted by filename, content normalized. These
 * are what the judge grades against. Throws on zero docs: a judge with no
 * reference documents cannot rule anything unsupported.
 */
export function loadReferenceDocuments(root: string): ReferenceDocument[] {
  const documents = listCorpusDocFiles(root).map((filename) => ({
    filename,
    content: readCorpusDocument(root, filename),
  }));
  if (documents.length === 0) {
    throw new Error("no reference documents found in corpus/docs");
  }
  return documents;
}

/**
 * Parses corpus/cases.jsonl one line at a time, validating each row against
 * GoldenCaseSchema. Rejects duplicate case ids — the corpus hash is only
 * meaningful if ids are unique.
 */
export function loadCorpus(path: string): GoldenCase[] {
  const text = readUtf8(path);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const cases: GoldenCase[] = [];
  const seenIds = new Set<string>();

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`corpus line ${index + 1}: invalid JSON`);
    }

    const row = GoldenCaseSchema.parse(parsed);
    if (seenIds.has(row.id)) {
      throw new Error(`corpus: duplicate case id ${row.id}`);
    }
    seenIds.add(row.id);
    cases.push(row);
  }

  return cases;
}
