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
- Rubric, judge prompt, model_id, decoding, output schema, scoring-path code:
  each edit yields exactly one `evaluator_id_mismatch` naming that component.
- Agent code edit, rubric rewritten with CRLF + BOM: no failure.
- Case or reference-doc edit: `corpus_hash_mismatch`.
- Stated results that disagree with a recomputation: `results_mismatch` naming
  the metric.
- Stated verdict that a reparse of its raw judge response does not reproduce:
  `manifest_invalid` naming the case.
- Honest results below the gate (a critical miss): `threshold_violation`
  naming the metric.
- Single-run evidence: `threshold_violation` on the absent self_consistency.
- Manifest thresholds differing from validation/thresholds.json, or a
  different threshold_source: `manifest_invalid`.
- Missing or schema-invalid manifest: exactly one `manifest_invalid`.
- A case with no observations: `manifest_invalid` naming the case.
- evaluator_components that do not combine to evaluator_id: `manifest_invalid`
  plus the component mismatch (or a generic `evaluator_id_mismatch` when only
  evaluator_id was edited).

`npm test` runs without `--passWithNoTests`: a misconfigured glob that finds
zero tests fails instead of reporting green.
