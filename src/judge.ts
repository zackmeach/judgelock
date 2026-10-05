import { createHash } from "node:crypto";
import OpenAI from "openai";
import type { Provider } from "./config.ts";
import { OPENAI_ENV_KEY, requireEnv } from "./env-file.ts";
import { compareCodeUnits, normalizeBlob } from "./identity.ts";
import type {
  EvaluatorConfig,
  GoldenCase,
  ReferenceDocument,
  Verdict,
} from "./types.ts";
import { VerdictSchema } from "./types.ts";

/** What one judge call returned, before it becomes an Observation. */
export interface JudgeResponse {
  raw: string;
  /** The model id the API reported actually serving this request. */
  resolved_model_id: string;
  /** The API's response id. */
  response_id: string;
  /** choices[0].finish_reason: "length" marks a truncation. */
  finish_reason: string | null;
  /** choices[0].message.refusal: set when the model refused. */
  refusal: string | null;
}

export interface JudgeCallOptions {
  provider: Provider;
}

const INVALID_VERDICT: Verdict = {
  label: "invalid_judge_output",
  severity: "standard",
  evidence: "",
};

const PROMPT_PLACEHOLDERS = ["rubric", "documents", "question", "answer"] as const;
export type PromptValues = Record<(typeof PROMPT_PLACEHOLDERS)[number], string>;

/**
 * Substitutes every `{{name}}` in one pass. A function replacement means `$`
 * sequences in inserted text are literal, and inserted text is never
 * re-scanned, so a question containing `{{answer}}` stays literal. Throws on
 * any `{{...}}` whose name is not exactly one of the four (so `{{ question }}`
 * fails instead of reaching the judge), and on a template missing any of the
 * four: a template without `{{documents}}` would silently grade without the
 * docs.
 */
export function renderPrompt(template: string, values: PromptValues): string {
  for (const key of PROMPT_PLACEHOLDERS) {
    if (!template.includes(`{{${key}}}`)) {
      throw new Error(`judge prompt template is missing {{${key}}}`);
    }
  }
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, key: string) => {
    if (!(PROMPT_PLACEHOLDERS as readonly string[]).includes(key)) {
      throw new Error(`judge prompt template has unknown placeholder {{${key}}}`);
    }
    return values[key as keyof PromptValues];
  });
}

/**
 * Renders reference documents for `{{documents}}`. Sorts by filename and
 * normalizes content itself rather than trusting the loader: corpus-docs.ts
 * is outside the implementation digest, so the order and bytes the judge
 * sees must be fixed here, in digested code.
 */
export function renderDocuments(documents: ReferenceDocument[]): string {
  return [...documents]
    .sort((a, b) => compareCodeUnits(a.filename, b.filename))
    .map(
      (doc) =>
        `<document filename="${doc.filename}">\n${normalizeBlob(doc.content)}\n</document>`,
    )
    .join("\n\n");
}

/**
 * Schema sent to the judge API — harness-owned labels are excluded. Works on
 * a clone: the input is not mutated, and key order is kept.
 */
export function judgeWireSchema(outputSchema: unknown): Record<string, unknown> {
  const schema = structuredClone(outputSchema) as Record<string, unknown>;
  const properties = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const label = properties?.label;
  if (label && Array.isArray(label.enum)) {
    label.enum = label.enum.filter(
      (value: string) => value !== "invalid_judge_output",
    );
  }
  return schema;
}

/**
 * The exact params object the OpenAI judge call sends. Pure: validate hashes
 * it into each observation and verify recomputes it from the working tree,
 * without a client or the network.
 */
export function buildJudgeRequest(
  config: EvaluatorConfig,
  documents: ReferenceDocument[],
  testCase: GoldenCase,
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  const prompt = renderPrompt(config.judge_prompt_template, {
    rubric: config.rubric,
    documents: renderDocuments(documents),
    question: testCase.question,
    answer: testCase.answer,
  });

  return {
    model: config.model_id,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: config.decoding.max_tokens,
    ...(config.decoding.top_p !== undefined
      ? { top_p: config.decoding.top_p }
      : {}),
    ...(config.decoding.stop_sequences.length > 0
      ? { stop: config.decoding.stop_sequences }
      : {}),
    ...(config.decoding.temperature !== undefined
      ? { temperature: config.decoding.temperature }
      : {}),
    ...(config.decoding.reasoning_effort !== undefined
      ? { reasoning_effort: config.decoding.reasoning_effort }
      : {}),
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "verdict",
        strict: true,
        schema: judgeWireSchema(config.output_schema),
      },
    },
  };
}

/**
 * sha256 hex of JSON.stringify(request): the body bytes the SDK sends. No
 * normalization, so any change to what is sent changes the hash.
 */
export function requestSha256(
  request: OpenAI.ChatCompletionCreateParamsNonStreaming,
): string {
  return createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");
}

async function callOpenAiJudge(
  config: EvaluatorConfig,
  documents: ReferenceDocument[],
  testCase: GoldenCase,
): Promise<JudgeResponse> {
  const client = new OpenAI({ apiKey: requireEnv(OPENAI_ENV_KEY) });
  const response = await client.chat.completions.create(
    buildJudgeRequest(config, documents, testCase),
  );

  const choice = response.choices[0];
  const raw = choice?.message?.content ?? "";
  // No fallback to config.model_id: "" makes validate reject the run instead
  // of recording a served model the API never reported.
  const resolved_model_id = response.model ?? "";

  return {
    raw,
    resolved_model_id,
    response_id: response.id ?? "",
    finish_reason: choice?.finish_reason ?? null,
    refusal: choice?.message?.refusal ?? null,
  };
}

/**
 * Renders the judge prompt template against one case and the reference
 * documents and calls the configured provider API with the configured model
 * and decoding config. The only place in the codebase that touches the network.
 */
export async function callJudge(
  config: EvaluatorConfig,
  documents: ReferenceDocument[],
  testCase: GoldenCase,
  options: JudgeCallOptions,
): Promise<JudgeResponse> {
  const { provider } = options;

  switch (provider) {
    case "openai":
      return callOpenAiJudge(config, documents, testCase);
    case "anthropic":
      throw new Error("anthropic judge calls are not implemented yet");
    default: {
      const unexpected: never = provider;
      throw new Error(`unsupported provider: ${unexpected}`);
    }
  }
}

/**
 * Parses a raw judge response against the verdict output schema. A response
 * that does not conform becomes a verdict of `invalid_judge_output` rather
 * than an exception — an unparseable judge is a measurable property of the
 * evaluator, not a crash.
 */
export function parseVerdict(raw: string): Verdict {
  if (raw.trim().length === 0) {
    return INVALID_VERDICT;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return INVALID_VERDICT;
  }

  const result = VerdictSchema.safeParse(parsed);
  if (!result.success || result.data.label === "invalid_judge_output") {
    return INVALID_VERDICT;
  }

  return result.data;
}
