import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { computeImplementationDigest } from "./identity.ts";
import {
  DecodingConfigSchema,
  EvaluatorConfigSchema,
  GoldenCaseSchema,
  ManifestSchema,
  type EvaluatorConfig,
  type GoldenCase,
  type Manifest,
} from "./types.ts";

const RUBRIC_PATH = "rubric/rubric.yaml";
const PROMPT_PATH = "prompts/judge.txt";
const CONFIG_PATH = "evaluator.config.json";
const SCHEMA_PATH = "schemas/verdict.schema.json";
const LOCKFILE_PATH = "package-lock.json";
const SRC_DIR = "src";

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
 * Reads the six identity components off disk — rubric/rubric.yaml, the judge
 * prompt template, the configured model id and decoding config, and
 * schemas/verdict.schema.json — and computes the implementation digest over
 * the scoring module plus the lockfile. Validates against EvaluatorConfigSchema.
 * Throws rather than defaulting: a missing component is a broken evaluator,
 * not a zero value.
 */
export function loadEvaluatorConfig(root: string): EvaluatorConfig {
  const rubric = readUtf8(join(root, RUBRIC_PATH));
  const judge_prompt_template = readUtf8(join(root, PROMPT_PATH));
  const runtime = loadEvaluatorRuntimeConfig(root);
  const output_schema = readJson(join(root, SCHEMA_PATH));

  const srcRelativePaths = readdirSync(join(root, SRC_DIR))
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(SRC_DIR, name));
  const digestRelativePaths = [...srcRelativePaths, LOCKFILE_PATH];
  const implementation_digest = computeImplementationDigest(
    root,
    digestRelativePaths,
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

/**
 * Reads validation/approved-manifest.json and validates it against
 * ManifestSchema. This is the approved evidence; verify compares against it
 * and never writes to it.
 */
export function loadApprovedManifest(path: string): Manifest {
  return ManifestSchema.parse(readJson(path));
}

/**
 * Reads evaluator.lock.json — the recorded evaluator identity and the
 * per-component hashes that let a mismatch be attributed to a specific
 * component rather than reported as an opaque id change.
 */
export function loadLockfile(path: string): Record<string, string | null> {
  const raw = readJson(path) as {
    evaluator_id?: string | null;
    components?: Record<string, string | null>;
    corpus_hash?: string | null;
    locked_at?: string | null;
  };

  const out: Record<string, string | null> = {
    evaluator_id: raw.evaluator_id ?? null,
    corpus_hash: raw.corpus_hash ?? null,
    locked_at: raw.locked_at ?? null,
  };

  if (raw.components) {
    for (const [key, value] of Object.entries(raw.components)) {
      out[`components.${key}`] = value ?? null;
    }
  }

  return out;
}
