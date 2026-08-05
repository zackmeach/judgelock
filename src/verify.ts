import type { VerifyResult } from "./types.ts";

export interface VerifyOptions {
  root: string;
}

/**
 * The CI gate. Offline, deterministic, no network.
 *
 * Recomputes the evaluator id from the working tree and the corpus hash from
 * cases.jsonl, reads the approved manifest, recomputes the aggregate metrics
 * from its raw observations, and checks the recomputed metrics against the
 * manifest's thresholds.
 *
 * Fails on any of: the working tree's evaluator id differs from the approved
 * one, the corpus hash differs, the manifest's stated results disagree with a
 * recomputation from its own observations, or a recomputed metric violates a
 * threshold.
 */
export function verify(_opts: VerifyOptions): VerifyResult {
  throw new Error("not implemented");
}

/** Renders a VerifyResult as CI log output naming each divergence. */
export function formatVerifyResult(_result: VerifyResult): string {
  throw new Error("not implemented");
}
