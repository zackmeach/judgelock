import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  APPROVED_MANIFEST_PATH,
  CASES_PATH,
  THRESHOLDS_PATH,
  loadCorpus,
  loadEvaluatorConfig,
  loadReferenceDocuments,
  loadThresholds,
} from "./config.ts";
import {
  combineComponentHashes,
  componentHashes,
  computeCorpusHash,
  hashBlob,
  normalizeBlob,
} from "./identity.ts";
import { parseVerdict } from "./judge.ts";
import {
  ManifestSchema,
  type EvaluatorConfig,
  type Manifest,
  type Results,
  type Threshold,
  type VerifyFailure,
  type VerifyResult,
} from "./types.ts";
import {
  checkCoverage,
  compareObservations,
  computeResults,
  serializeManifest,
} from "./validate.ts";

export interface VerifyOptions {
  root: string;
}

function metric(results: Results, name: string): number | undefined {
  return Object.hasOwn(results, name) ? results[name] : undefined;
}

/**
 * Checks results against thresholds. Both bounds are inclusive: `min` passes
 * at value >= bound, `max` at value <= bound (critical_miss_rate max 0 must
 * pass a perfect judge). A threshold on a metric that was not computed fails.
 */
export function checkThresholds(
  results: Results,
  thresholds: Threshold[],
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const t of thresholds) {
    const value = metric(results, t.metric);
    if (value === undefined) {
      failures.push({
        kind: "threshold_violation",
        subject: t.metric,
        detail: `metric ${t.metric} was not computed`,
      });
      continue;
    }
    const ok = t.direction === "min" ? value >= t.bound : value <= t.bound;
    if (!ok) {
      failures.push({
        kind: "threshold_violation",
        subject: t.metric,
        detail: `${t.metric} = ${value} violates ${t.direction} ${t.bound}`,
      });
    }
  }
  return failures;
}

/**
 * The CI gate. Offline, deterministic, no network.
 *
 * Recomputes the evaluator id from the working tree and the corpus hash from
 * cases.jsonl and the corpus/docs reference documents, reads the approved
 * manifest, recomputes the aggregate metrics from its raw observations, and
 * checks the recomputed metrics against validation/thresholds.json.
 *
 * Fails on any of: no approved manifest, or one that does not parse; a
 * manifest not in canonical form (exactly serializeManifest's output, with
 * observations in canonical order), which stops all further checks; a
 * manifest whose evaluator_id is not the combination of its stated
 * components; a resolved_model_id that is not the model the model_id
 * component was hashed from; any identity component differing from the
 * approved one (named per component); the corpus hash differing; manifest thresholds differing
 * from validation/thresholds.json; a stated verdict that a reparse of its raw
 * judge response does not reproduce; observations not covering the current
 * cases exactly; stated results disagreeing with a recomputation; or a
 * recomputed metric violating (or missing for) a threshold.
 *
 * Manifest problems are reported, never thrown. Missing evaluator inputs
 * (rubric, config, corpus, thresholds) throw: there is nothing to verify
 * against.
 */
export function verify({ root }: VerifyOptions): VerifyResult {
  const working = componentHashes(loadEvaluatorConfig(root));
  const evaluator_id = combineComponentHashes(working);
  const cases = loadCorpus(join(root, CASES_PATH));
  const corpus_hash = computeCorpusHash(cases, loadReferenceDocuments(root));
  const thresholds = loadThresholds(root).thresholds;
  const failures: VerifyFailure[] = [];
  const result = (): VerifyResult => ({
    ok: failures.length === 0,
    evaluator_id,
    corpus_hash,
    failures,
  });

  const manifestPath = join(root, APPROVED_MANIFEST_PATH);
  if (!existsSync(manifestPath)) {
    failures.push({
      kind: "manifest_invalid",
      detail: `no approved manifest at ${APPROVED_MANIFEST_PATH} — run validate and promote a reviewed candidate`,
    });
    return result();
  }
  // BOM and line endings are normalized; every other byte must be canonical.
  let text: string;
  let manifest: Manifest;
  try {
    text = normalizeBlob(readFileSync(manifestPath, "utf8"));
    manifest = ManifestSchema.parse(JSON.parse(text));
  } catch (err) {
    const message =
      err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    failures.push({
      kind: "manifest_invalid",
      detail: `${APPROVED_MANIFEST_PATH} is not a valid manifest: ${message}`,
    });
    return result();
  }

  // JSON.parse keeps the last duplicate key and zod drops unknown fields and
  // `__proto__`, so a manifest that only parses can say more than verify checks.
  if (text !== serializeManifest(manifest)) {
    failures.push({
      kind: "manifest_invalid",
      detail:
        "approved manifest is not in canonical form (re-serialize the candidate with validate; hand edits, duplicate keys, unknown fields and key reordering are rejected)",
    });
    return result();
  }
  const observations = manifest.raw_observations;
  if (observations.some((o, i) => i > 0 && compareObservations(observations[i - 1]!, o) > 0)) {
    failures.push({
      kind: "manifest_invalid",
      detail:
        "approved manifest raw_observations are not in canonical order (case_id by code unit, then run_index)",
    });
    return result();
  }

  const stated = combineComponentHashes(manifest.evaluator_components);
  if (stated !== manifest.evaluator_id) {
    failures.push({
      kind: "manifest_invalid",
      detail: `manifest evaluator_id ${manifest.evaluator_id} is not the combination of its evaluator_components (${stated})`,
    });
  }

  // Compared to the manifest's own model_id component, not the working tree's:
  // a working-tree model change is already reported as the model_id component.
  if (hashBlob(manifest.resolved_model_id) !== manifest.evaluator_components.model_id) {
    failures.push({
      kind: "manifest_invalid",
      subject: "resolved_model_id",
      detail: `resolved_model_id ${JSON.stringify(manifest.resolved_model_id)} is not the model the manifest's model_id component was hashed from`,
    });
  }

  const moved = (Object.keys(working) as (keyof EvaluatorConfig)[]).filter(
    (key) => working[key] !== manifest.evaluator_components[key],
  );
  for (const key of moved) {
    failures.push({
      kind: "evaluator_id_mismatch",
      subject: key,
      detail: `${key} changed since approval`,
      expected: manifest.evaluator_components[key],
      actual: working[key],
    });
  }
  if (moved.length === 0 && evaluator_id !== manifest.evaluator_id) {
    failures.push({
      kind: "evaluator_id_mismatch",
      detail: "evaluator_id differs from the approved one",
      expected: manifest.evaluator_id,
      actual: evaluator_id,
    });
  }

  if (corpus_hash !== manifest.corpus_hash) {
    failures.push({
      kind: "corpus_hash_mismatch",
      detail: "corpus (cases or reference documents) changed since approval",
      expected: manifest.corpus_hash,
      actual: corpus_hash,
    });
  }

  if (manifest.threshold_source !== THRESHOLDS_PATH) {
    failures.push({
      kind: "manifest_invalid",
      detail: `threshold_source must be ${THRESHOLDS_PATH}`,
      expected: manifest.threshold_source,
      actual: THRESHOLDS_PATH,
    });
  }
  if (!isDeepStrictEqual(manifest.thresholds, thresholds)) {
    failures.push({
      kind: "manifest_invalid",
      detail: `manifest thresholds differ from ${THRESHOLDS_PATH}`,
      expected: JSON.stringify(manifest.thresholds),
      actual: JSON.stringify(thresholds),
    });
  }

  for (const o of manifest.raw_observations) {
    const reparsed = parseVerdict(o.raw_judge_response);
    if (!isDeepStrictEqual(reparsed, o.verdict)) {
      failures.push({
        kind: "manifest_invalid",
        subject: o.case_id,
        detail: `case ${JSON.stringify(o.case_id)} run ${o.run_index}: stated verdict ${JSON.stringify(o.verdict)} is not what raw_judge_response parses to (${JSON.stringify(reparsed)})`,
      });
    }
  }

  const coverage = checkCoverage(manifest.raw_observations, cases);
  for (const p of coverage) {
    failures.push({ kind: "manifest_invalid", subject: p.case_id, detail: p.detail });
  }
  if (coverage.length > 0) return result();

  const recomputed = computeResults(manifest.raw_observations, cases);
  const names = [...new Set([...Object.keys(manifest.results), ...Object.keys(recomputed)])].sort();
  for (const name of names) {
    const s = metric(manifest.results, name);
    const r = metric(recomputed, name);
    if (s !== r) {
      failures.push({
        kind: "results_mismatch",
        subject: name,
        detail: `${name} stated in the manifest does not match recomputation from raw_observations`,
        expected: String(s ?? "absent"),
        actual: String(r ?? "absent"),
      });
    }
  }

  failures.push(...checkThresholds(recomputed, thresholds));
  return result();
}

/** Renders a VerifyResult as CI log output naming each divergence. */
export function formatVerifyResult(result: VerifyResult): string {
  const n = result.failures.length;
  const lines = [
    result.ok
      ? "judgelock verify: PASS"
      : `judgelock verify: FAIL (${n} problem${n === 1 ? "" : "s"})`,
    `evaluator_id ${result.evaluator_id}`,
    `corpus_hash ${result.corpus_hash}`,
  ];
  for (const f of result.failures) {
    const [was, now] =
      f.kind === "results_mismatch" ? ["stated", "recomputed"] : ["approved", "working"];
    lines.push("", `[${f.kind}] ${f.detail}`);
    if (f.expected !== undefined) lines.push(`  ${was}: ${f.expected}`);
    if (f.actual !== undefined) lines.push(`  ${now}: ${f.actual}`);
  }
  return lines.join("\n");
}
