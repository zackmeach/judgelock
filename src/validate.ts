import type { Manifest, Observation, Results } from "./types.ts";

export interface ValidateOptions {
  root: string;
  /** Repeat count per case. >1 is what makes judge self-consistency measurable. */
  runs: number;
  /** Where the candidate manifest is written. Never the approved manifest. */
  out: string;
}

/**
 * Computes the aggregate metrics from raw observations. Shared with verify —
 * verify recomputes with this exact function, so a manifest whose stated
 * results disagree with its own raw observations is caught rather than
 * believed.
 */
export function computeResults(
  _observations: Observation[],
  _root: string,
): Results {
  throw new Error("not implemented");
}

/**
 * Makes real judge API calls across the golden set and writes a *candidate*
 * manifest plus a human-readable report under validation/reports/. Manual
 * dispatch only. Never writes to validation/approved-manifest.json —
 * promoting a candidate to approved is a human act, reviewed in a PR.
 */
export async function validate(_opts: ValidateOptions): Promise<Manifest> {
  throw new Error("not implemented");
}
