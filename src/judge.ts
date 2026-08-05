import type {
  EvaluatorConfig,
  GoldenCase,
  Observation,
  Verdict,
} from "./types.ts";

/** What one judge call returned, before it becomes an Observation. */
export interface JudgeResponse {
  raw: string;
  /** The model id the API reported actually serving this request. */
  resolved_model_id: string;
}

/**
 * Renders the judge prompt template against one case and calls the Anthropic
 * API with the configured model and decoding config. The only place in the
 * codebase that touches the network.
 */
export async function callJudge(
  _config: EvaluatorConfig,
  _testCase: GoldenCase,
): Promise<JudgeResponse> {
  throw new Error("not implemented");
}

/**
 * Parses a raw judge response against the verdict output schema. A response
 * that does not conform becomes a verdict of `invalid_judge_output` rather
 * than an exception — an unparseable judge is a measurable property of the
 * evaluator, not a crash.
 */
export function parseVerdict(_raw: string): Verdict {
  throw new Error("not implemented");
}

/** Runs one case once and records the result as an Observation. */
export async function runCase(
  _config: EvaluatorConfig,
  _testCase: GoldenCase,
  _runIndex: number,
): Promise<Observation> {
  throw new Error("not implemented");
}
