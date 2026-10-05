# judgelock

An LLM judge is a measuring instrument. Change its rubric, prompt, model, decoding settings, output schema, or scoring code and every score it gives afterwards means something different from every score it gave before. judgelock gives the judge a content-addressed identity, binds that identity to human-labeled validation evidence in a committed manifest, and fails CI when the judge or its corpus no longer matches what the evidence was collected on.

The judge here grades answers from a Medicare enrollment Q&A agent against reference documents from medicare.gov and the eCFR.

**Status: in development — no approved manifest yet; CI verify fails closed until one is promoted.**

## How it works

### Evaluator identity

`evaluator_id` is a sha256 over six component hashes, combined in a fixed order:

| component | source |
| --- | --- |
| `rubric` | `rubric/rubric.yaml` |
| `judge_prompt_template` | `prompts/judge.txt`, placeholders unsubstituted |
| `model_id` | `evaluator.config.json`: a pinned, dated snapshot id, never an alias |
| `decoding` | `evaluator.config.json`: `max_tokens`, `reasoning_effort`, stop sequences, and any pinned `temperature` / `top_p` |
| `output_schema` | `schemas/verdict.schema.json`, key order included |
| `implementation_digest` | sha256 over the scoring-path sources `src/config.ts`, `src/identity.ts`, `src/judge.ts`, `src/types.ts`, `src/validate.ts`, plus `package-lock.json` |

Deliberately outside the digest:

- `src/corpus-docs.ts`. It selects and loads the reference documents; their content is captured by `corpus_hash`, and `renderDocuments` in `src/judge.ts` re-sorts and re-normalizes them before the judge sees them.
- Agent, shell, `src/verify.ts`, `src/report.ts`, and `src/cli.ts`, so editing the subject agent or how results are presented never moves the judge's identity.
- `provider` in `evaluator.config.json`: runtime wiring, not hashed (`model_id` is).

`top_k` is rejected for the OpenAI judge: the API does not accept it, so it would be hashed but never sent.

An import-closure test in `tests/identity.test.ts` fails if a digested file references a relative module that is neither digested nor allowlisted with a reason (today: `src/env-file.ts`, `src/corpus-docs.ts`), or loads a module in a way a string scan cannot resolve.

What the API reports actually serving is recorded in the manifest as `resolved_model_id`. verify requires it to hash to the manifest's `model_id` component, i.e. to be exactly the configured snapshot id, so an alias the API resolves to some other string can never be approved.

### Corpus hash

`corpus_hash` is a sha256 over the golden cases (`corpus/cases.jsonl`, sorted by id) and the reference documents (`corpus/docs/*.md`, sorted by filename). Reordering either is not a change; editing, adding, or removing any case or document is.

### Normalization

Every blob is normalized before hashing: CRLF and lone CR become LF, and a UTF-8 BOM is stripped. JSON is serialized with sorted keys at every depth, with one exception: `output_schema` is hashed in its file key order, because the judge request sends the schema in that order and structured outputs generate properties in schema order, so reordering them can change verdicts. Sorts use UTF-16 code-unit order, never locale collation. Two checkouts of the same commit on different machines produce the same ids.

### The manifest

A manifest contains:

- `evaluator_id` and the six `evaluator_components` hashes behind it
- `corpus_hash`
- `resolved_model_id`
- `raw_observations`: every case × run, with the parsed verdict, the raw judge response, `request_sha256` (the sha256 of the exact request body sent to the judge), and `response` (the API's response id, `finish_reason`, and `refusal`, so a refusal and a truncation are distinguishable even though both leave the raw response empty)
- `results`: the metrics, computed from `raw_observations`
- `thresholds` and `threshold_source` (`validation/thresholds.json`)

### Metrics and thresholds

| metric | definition |
| --- | --- |
| `agreement` | fraction of observations whose label equals the human label |
| `critical_miss_rate` | among observations of critical non-pass cases, the fraction the judge labeled `pass` |
| `invalid_output_rate` | fraction of observations whose response did not parse against the verdict schema |
| `self_consistency` | fraction of cases whose runs all share one label; computed only when every case has at least 2 runs |
| `false_pass_rate` | report-only: among observations of non-pass cases, the fraction the judge labeled `pass` |
| `severity_agreement` | report-only: among observations of non-pass cases that the judge labeled neither `pass` nor `invalid_judge_output`, the fraction whose severity equals the human severity |

Bounds are inclusive: `min` passes at value ≥ bound, `max` at value ≤ bound. A metric that was not computed fails its threshold, so a single-run candidate always fails `self_consistency`. Current bounds: agreement ≥ 0.85, critical_miss_rate ≤ 0, invalid_output_rate ≤ 0.02, self_consistency ≥ 0.90, with the rationale in the file. The provenance of the bounds is the git history of `validation/thresholds.json`: they were committed before the first validation run, so they cannot be quietly fitted to results.

`false_pass_rate` and `severity_agreement` are measured, not gated: no threshold applies to them. They are recomputed by verify like every other metric (a stated value that disagrees is a `results_mismatch`), shown in the report's "Report-only metrics" section, and omitted when their denominator is zero.

`validation/thresholds.json` also pins `runs`, the repeats per case that promotable evidence must have (3). Fewer repeats make `self_consistency` and the zero critical-miss bound easier to meet, so the operator does not get to choose it: verify rejects evidence with any other run count, and the report says "eligible for promotion" only when every threshold passes and the run count matches.

### verify

`npm run verify` is the CI gate: offline, deterministic, no secrets, no API client. It recomputes the evaluator id and corpus hash from the working tree, reads `validation/approved-manifest.json`, recomputes the metrics from its raw observations, and fails on any of the following. The approved manifest must be in canonical form: byte for byte what `validate` writes (`serializeManifest`), BOM and line endings aside, with observations in canonical order. That way the text a reviewer reads is exactly the evidence verify enforces.

Request binding: verify also rebuilds, from the working tree, the exact judge request each observation's case would send and compares its sha256 to the observation's `request_sha256`. Component hashes say what the instrument is; request hashes say the evidence was collected with that instrument. A manifest whose `evaluator_id` and components were re-stamped for an edited tree, with observations from the old one, fails here. Forging past it means rewriting every observation's request hash, a full-manifest diff rather than a few lines; only human review of the promotion PR stops a determined forger.

- `evaluator_id_mismatch`: an identity component differs from the approved one, named per component
- `corpus_hash_mismatch`: a case or reference document changed
- `request_mismatch`: with no `evaluator_id_mismatch` or `corpus_hash_mismatch` (either already explains the drift), some observations carry a `request_sha256` that is not the hash of the request the working tree would send; one failure giving the count and the first case ids
- `results_mismatch`: a metric stated in the manifest disagrees with the recomputation, named per metric
- `threshold_violation`: a recomputed metric violates its threshold or was not computed
- `manifest_invalid`: no approved manifest, or one that does not parse; a manifest not in canonical form (hand edits, duplicate keys, unknown fields, reordered keys or observations), which stops all further checks; an `evaluator_id` that is not the combination of its stated components; a `resolved_model_id` that is not the model the `model_id` component was hashed from; thresholds or `threshold_source` that differ from `validation/thresholds.json`; a stated verdict that a reparse of its raw judge response does not reproduce; observations that do not cover the current cases exactly; a run count per case other than the `runs` pinned in `validation/thresholds.json`

## Workflow

1. Edit an identity component (rubric, judge prompt, model, decoding, schema, scoring code) or the corpus.
2. `npm run verify` fails, naming what moved.
3. Run the golden set against the judge. This makes real API calls and costs money.

   ```bash
   npm run validate
   ```

   `--runs` defaults to the `runs` pinned in `validation/thresholds.json` (3) and is capped at 10. Other counts are allowed for exploration, but only the pinned count is promotable. The run writes a report at `validation/reports/<UTC timestamp>-<first 12 of evaluator_id>.md`, then `validation/candidate-manifest.json`, and prints the candidate's sha256, each threshold's PASS/FAIL, and an overall verdict. It exits 0 whenever a candidate was produced, even one that fails thresholds. It exits nonzero and writes nothing if `--runs` is not an integer from 1 to 10; if `--out` is not a `.json` file inside `validation/`, or is `validation/approved-manifest.json` or `validation/thresholds.json` (compared case-insensitively on Windows and macOS); if `OPENAI_BASE_URL` is set (it reroutes the judge and is not recorded in the evidence); or if any judge call fails after the SDK's retries. It aborts at the first response that reports no served model or a served model other than the configured `model_id` (verify would reject that candidate), without starting further calls. The manual-dispatch `validate` GitHub Actions workflow does the same run (default 3 runs), uploads `validation/` as an artifact even if the run or push fails, and commits the candidate and report to the branch.
4. Review the candidate and the report: thresholds, disagreements with the human labels, cases whose runs disagree with each other, invalid judge outputs. The report's `candidate sha256` is over the candidate file's exact bytes, so `sha256sum` or `Get-FileHash` on the candidate must match it.
5. Promote in a pull request by copying the candidate over the approved manifest. Promotion is always a human act in a reviewed PR: `validate` refuses an `--out` that resolves to `validation/approved-manifest.json`, and no other command writes it.

   ```bash
   cp validation/candidate-manifest.json validation/approved-manifest.json
   ```

6. `npm run verify` passes.

   ```bash
   npm run verify
   ```

### Failure policy

If a validation run fails thresholds, change the instrument (judge prompt, rubric, model, reasoning effort) and re-validate. Never edit golden labels after seeing judge output: a label changed to match the judge measures the judge against itself.

What the gate certifies at this size: with the golden set's 9 critical cases at 3 runs, zero misses in 27 critical observations bounds the true critical miss rate only to about 10.5% (95% upper bound, observation level). Runs of one case are not independent, so at case level it is 0 of 9, bounding it only to about 28%. Passing the gate means no miss was observed, not that misses are rare.

## Tests

Judge calls use injected fakes; no test makes a network call by default.

```bash
npm test
```

The API key smoke tests in `tests/live.test.ts` cost money and are opt-in: they run only when `JUDGELOCK_LIVE=1` and the key is set.

```bash
JUDGELOCK_LIVE=1 npm test
```

```powershell
$env:JUDGELOCK_LIVE = "1"; npm test
```

## Repository layout

```
.github/workflows/
  verify.yml                   typecheck + tests, and the offline verify gate (push, PR)
  validate.yml                 manual dispatch: golden-set run, uploads and commits candidate + report
corpus/
  cases.jsonl                  human-labeled golden set: question, answer, human label and severity
  docs/                        reference documents the judge grades against
  SOURCES.md                   source URLs, fetch dates, anchor checks
evaluator.config.json          judge provider, model_id, decoding
agent.config.json              subject agent provider, model_id, decoding (not judge identity)
prompts/
  judge.txt                    judge prompt template
  agent.txt                    subject agent system prompt
rubric/rubric.yaml             grading criteria
schemas/verdict.schema.json    judge output contract
validation/
  thresholds.json              the committed gate, pinned runs per case, and the rationale
  reports/                     Markdown validation reports
  candidate-manifest.json      written by validate (absent until a run)
  approved-manifest.json       the promoted manifest (absent until promoted)
src/
  cli.ts                       shell | verify | validate dispatch; writes candidate and report
  config.ts                    loads on-disk inputs; implementation digest file list
  identity.ts                  normalization, evaluator id, corpus hash, digest
  judge.ts                     prompt rendering, judge API call, verdict parsing
  validate.ts                  golden-set run, coverage check, metrics, manifest assembly
  types.ts                     shared types and zod schemas
  verify.ts                    offline drift check
  report.ts                    Markdown validation report
  corpus-docs.ts               reference document listing, loading, search
  env-file.ts                  .env loading and API key helpers
  agent.ts                     subject agent session
  agent-tools.ts               agent corpus tools: list, read, search documents
  provider-chat.ts             provider chat loop with tool calls
  api-key-test.ts              API key smoke tests
  shell/                       interactive terminal
tests/
  identity.test.ts             hashing, normalization, digest scope, import closure
  judge.test.ts                prompt rendering, document rendering, verdict parsing
  validate.test.ts             validate with fake judges, report rendering, CLI refusals (keyless)
  mutation/verify.test.ts      deliberate-drift tests for verify
  agent-tools.test.ts          agent corpus tools
  health.test.ts               bootstrap checks
  live.test.ts                 live API key smoke tests (opt-in: JUDGELOCK_LIVE=1 and a key)
```

## Subject agent and shell

```bash
npm run shell
```

opens an interactive terminal (`npm start` does the same):

- `chat [message]` talks to the Medicare enrollment agent (`agent.config.json`, `prompts/agent.txt`), which answers using tools that list, read, and search `corpus/docs`. Inside chat, `/grade` runs the judge once on the last question and answer and prints the verdict and evidence; nothing is recorded. `/exit` leaves chat.
- `keys` shows API key status; `keys set <openai|anthropic> [value]` saves a key to `.env`; `keys test` smoke-tests the configured keys.
- `status`, `clear`, `help`, `exit`.

The agent is the system under evaluation, not part of the judge: its config, prompt, and code are outside the evaluator identity.

## Requirements

- Node ≥ 22.6. Scripts run the TypeScript sources directly with `--experimental-strip-types`.
- `OPENAI_API_KEY` for `validate` and `/grade`, from the environment or `.env` (see `.env.example`).
- `ANTHROPIC_API_KEY` for the agent chat.
- `verify` and `npm test` need no keys.
