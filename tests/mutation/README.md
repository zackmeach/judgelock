# Mutation tests

Deliberate-drift tests for `verify`. Each test builds a fresh temp repo from
the real instrument (rubric, prompts, schemas, configs, src/, lockfile,
thresholds) plus a synthetic corpus, writes an approved manifest for it,
applies exactly one mutation, and asserts the failures `verify` reports by
kind and subject, so drift is named rather than reported as an opaque id
change. The synthetic corpus keeps the suite independent of the real golden
set.

What the suite pins:

- Untouched fixture: `verify` passes with zero failures.
- Rubric, judge prompt, model_id, decoding, output schema (a description
  edit, and reordered properties: the schema is hashed in key order),
  scoring-path code: each edit yields exactly one `evaluator_id_mismatch`
  naming that component, and no `request_mismatch` on top.
- Agent code edit, rubric rewritten with CRLF + BOM: no failure.
- Case or reference-doc edit: `corpus_hash_mismatch`.
- Stated results that disagree with a recomputation, including an extra stated
  metric: `results_mismatch` naming the metric.
- Stated verdict that a reparse of its raw judge response does not reproduce,
  pinned separately for label, severity and evidence: `manifest_invalid`
  naming the case.
- Honest results below the gate (a critical miss): `threshold_violation`
  naming the metric. Gating uses validation/thresholds.json, so a manifest
  that loosens its own copy still gets the violation (plus `manifest_invalid`).
- Evidence at fewer runs than validation/thresholds.json pins (3): exactly
  one `manifest_invalid` for two runs; single-run evidence adds the
  `threshold_violation` on the absent self_consistency.
- Manifest thresholds differing from validation/thresholds.json, or a
  different threshold_source: `manifest_invalid`.
- Missing or schema-invalid manifest: exactly one `manifest_invalid`.
- Manifest not in canonical form (duplicate key, `__proto__` key, extra field,
  `-0`, reordered keys, observations out of order): exactly one
  `manifest_invalid`. A CRLF + BOM copy of a canonical manifest passes.
- resolved_model_id that is not the model the manifest's model_id component
  was hashed from (everything else re-stamped to a new model, or empty):
  `manifest_invalid` on resolved_model_id.
- Request binding: an edited tree with a re-stamped manifest (evaluator_id
  and components recomputed, observations untouched) yields exactly one
  `request_mismatch`, for a rubric edit, reordered schema properties, and a
  model swap with resolved_model_id re-stamped too. One forged observation
  hash is counted and named.
- A case with no observations: `manifest_invalid` naming the case.
- evaluator_components that do not combine to evaluator_id: `manifest_invalid`
  plus the component mismatch (or a generic `evaluator_id_mismatch` when only
  evaluator_id was edited).

What re-stamping now takes: each observation carries the sha256 of the
request body the SDK actually sent, and verify rebuilds the request from the
working tree. A re-stamp over a change to anything the request carries has
to forge every observation's request hash as well as evaluator_id and the
components, a diff across the whole manifest rather than a few lines. The
exception is a change only to the transport (callOpenAiJudge altering the
body after buildJudgeRequest): old evidence still matches the rebuilt
request, so re-stamping evaluator_id and implementation_digest passes, and
the divergence becomes a `request_mismatch` only once evidence is collected
through the changed transport (pinned in tests/validate.test.ts). This
raises the cost and visibility of forgery; it does not prevent it. A
determined forger can still compute the hashes, and only human review of
the promotion PR stops them.

`npm test` runs without `--passWithNoTests`: a misconfigured glob that finds
zero tests fails instead of reporting green.
