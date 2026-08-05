# judgelock

Gives an LLM-as-judge evaluator one content-addressed identity, binds it to the human-labeled validation evidence that approved it, and fails CI when they diverge.

**Status: in development.**

## Layout

```
docs/                          fictional elections-data API under evaluation
rubric/rubric.yaml             grading criteria
corpus/cases.jsonl             human-labeled golden set
schemas/verdict.schema.json    judge output contract
validation/
  approved-manifest.json       the evidence CI checks against
  reports/                     permanently linkable validation reports
src/
  cli.ts                       verify | validate dispatch
  config.ts                    load + validate on-disk inputs
  identity.ts                  evaluator id and corpus hash
  judge.ts                     judge API call and verdict parsing
  validate.ts                  golden-set run, writes candidate manifest
  verify.ts                    offline drift check
  types.ts                     shared types and schemas
tests/mutation/                deliberate-drift tests
evaluator.lock.json            the locked evaluator identity
```
