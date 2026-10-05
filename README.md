# judgelock

Gives an LLM-as-judge evaluator one content-addressed identity, binds it to the human-labeled validation evidence that approved it, and fails CI when they diverge.

**Status: in development.**

## Layout

```
corpus/docs/                   Medicare enrollment reference docs
rubric/rubric.yaml             grading criteria
corpus/cases.jsonl             human-labeled golden set
schemas/verdict.schema.json    judge output contract
validation/
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
```
