import OpenAI from "openai";
import type { Provider } from "./config.ts";
import { OPENAI_ENV_KEY, requireEnv } from "./env-file.ts";
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
}

export interface JudgeCallOptions {
  /** Defaults to inference from model_id when omitted. */
  provider?: Provider;
}

const INVALID_VERDICT: Verdict = {
  label: "invalid_judge_output",
  severity: "standard",
  evidence: "",
};

function inferProvider(modelId: string): Provider {
  const id = modelId.toLowerCase();
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) {
    return "openai";
  }
  if (id.startsWith("claude-")) {
    return "anthropic";
  }
  throw new Error(
    `cannot infer API provider for model_id ${modelId}; pass provider explicitly`,
  );
}

const PROMPT_PLACEHOLDERS = ["rubric", "documents", "question", "answer"] as const;
export type PromptValues = Record<(typeof PROMPT_PLACEHOLDERS)[number], string>;

/**
 * Substitutes every `{{name}}` in one pass. A function replacement means `$`
 * sequences in inserted text are literal, and inserted text is never
 * re-scanned, so a question containing `{{answer}}` stays literal. Throws on
 * an unknown placeholder, and on a template missing any of the four: a
 * template without `{{documents}}` would silently grade without the docs.
 */
export function renderPrompt(template: string, values: PromptValues): string {
  for (const key of PROMPT_PLACEHOLDERS) {
    if (!template.includes(`{{${key}}}`)) {
      throw new Error(`judge prompt template is missing {{${key}}}`);
    }
  }
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(PROMPT_PLACEHOLDERS as readonly string[]).includes(key)) {
      throw new Error(`judge prompt template has unknown placeholder {{${key}}}`);
    }
    return values[key as keyof PromptValues];
  });
}

/** Renders reference documents for `{{documents}}`, in the given order. */
export function renderDocuments(documents: ReferenceDocument[]): string {
  return documents
    .map((doc) => `### ${doc.filename}\n\n${doc.content}`)
    .join("\n\n---\n\n");
}

/** Schema sent to the judge API — harness-owned labels are excluded. */
function judgeOutputSchema(outputSchema: unknown): Record<string, unknown> {
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

async function callOpenAiJudge(
  config: EvaluatorConfig,
  documents: ReferenceDocument[],
  testCase: GoldenCase,
): Promise<JudgeResponse> {
  const client = new OpenAI({ apiKey: requireEnv(OPENAI_ENV_KEY) });
  const prompt = renderPrompt(config.judge_prompt_template, {
    rubric: config.rubric,
    documents: renderDocuments(documents),
    question: testCase.question,
    answer: testCase.answer,
  });

  const response = await client.chat.completions.create({
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
        schema: judgeOutputSchema(config.output_schema),
      },
    },
  });

  const choice = response.choices[0];
  const raw = choice?.message?.content ?? "";
  const resolved_model_id = response.model ?? config.model_id;

  return { raw, resolved_model_id };
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
  options?: JudgeCallOptions,
): Promise<JudgeResponse> {
  const provider = options?.provider ?? inferProvider(config.model_id);

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
