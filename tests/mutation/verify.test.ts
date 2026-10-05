import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APPROVED_MANIFEST_PATH,
  CASES_PATH,
  loadCorpus,
  loadEvaluatorConfig,
  loadReferenceDocuments,
  loadThresholds,
} from "../../src/config.ts";
import { componentHashes, computeEvaluatorId } from "../../src/identity.ts";
import { buildJudgeRequest, requestSha256 } from "../../src/judge.ts";
import type {
  GoldenCase,
  Manifest,
  Observation,
  Verdict,
  VerifyResult,
} from "../../src/types.ts";
import {
  buildManifest,
  checkCoverage,
  computeResults,
  serializeManifest,
} from "../../src/validate.ts";
import { checkThresholds, formatVerifyResult, verify } from "../../src/verify.ts";
import { ROOT } from "../root.ts";

/** The real instrument, copied verbatim into each fixture. */
const INSTRUMENT = [
  "rubric",
  "prompts",
  "schemas",
  "evaluator.config.json",
  "package-lock.json",
  "src",
  "validation/thresholds.json",
];

/** Synthetic corpus: the suite never depends on the real golden set. */
const CASES: GoldenCase[] = [
  {
    id: "case-pass",
    question: "When can I first enroll in Part B?",
    answer: "During the 7-month initial enrollment period around your 65th birthday.",
    human_label: "pass",
    human_severity: "standard",
  },
  {
    id: "case-critical",
    question: "Is there a penalty for enrolling in Part B late?",
    answer: "No, there is never a penalty.",
    human_label: "incorrect",
    human_severity: "critical",
  },
  {
    id: "case-standard",
    question: "What is the Part B premium?",
    answer: "There is a monthly premium.",
    human_label: "incomplete",
    human_severity: "standard",
  },
  {
    id: "case-unsupported",
    question: "Can I delay Part B while covered by my spouse's employer plan?",
    answer: "Yes, for up to 24 months after the coverage ends.",
    human_label: "unsupported",
    human_severity: "critical",
  },
];

const DOCS: Record<string, string> = {
  "a-enrollment.md": "# Enrollment\nThe initial enrollment period is 7 months long.\n",
  "b-penalty.md": "# Penalty\nLate Part B enrollment adds 10% per full 12-month period.\n",
};

const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const honest = (c: GoldenCase): Verdict => ({
  label: c.human_label,
  severity: c.human_severity,
  evidence: `evidence for ${c.id}`,
});

/** Judges the critical non-pass case "case-critical" as pass; honest otherwise. */
const missCritical = (c: GoldenCase): Verdict =>
  c.id === "case-critical" ? { ...honest(c), label: "pass" } : honest(c);

/** validation/thresholds.json runs: the only promotable runs per case. */
const RUNS = loadThresholds(ROOT).runs;

/** request_sha256 is a placeholder until writeManifest stamps it for a fixture. */
function observe(runs: number, judge: (c: GoldenCase) => Verdict = honest): Observation[] {
  return CASES.flatMap((c) =>
    Array.from({ length: runs }, (_, run_index) => {
      const verdict = judge(c);
      return {
        case_id: c.id,
        run_index,
        request_sha256: "0".repeat(64),
        verdict,
        raw_judge_response: JSON.stringify(verdict),
        response: { id: `resp-${c.id}-${run_index}`, finish_reason: "stop", refusal: null },
      };
    }),
  );
}

/**
 * Builds a manifest from the fixture's own inputs, optionally edits it, writes
 * it. Stamps each observation's request_sha256 for the fixture's current tree,
 * as an honest validate run would.
 */
function writeManifest(
  dir: string,
  observations: Observation[],
  edit?: (m: Manifest) => void,
): void {
  const config = loadEvaluatorConfig(dir);
  const cases = loadCorpus(join(dir, CASES_PATH));
  const documents = loadReferenceDocuments(dir);
  const stamped = observations.map((o) => {
    const c = cases.find((x) => x.id === o.case_id);
    return c ? { ...o, request_sha256: requestSha256(buildJudgeRequest(config, documents, c)) } : o;
  });
  const manifest = buildManifest({
    config,
    cases,
    documents,
    observations: stamped,
    resolvedModelId: config.model_id,
    thresholds: loadThresholds(dir),
  });
  edit?.(manifest);
  writeFileSync(join(dir, APPROVED_MANIFEST_PATH), serializeManifest(manifest));
}

/**
 * A forger's re-stamp: evaluator_id and components recomputed for the
 * fixture's current tree, observations (and their request hashes) untouched.
 */
function restamp(dir: string, edit?: (m: Manifest) => void): void {
  const path = join(dir, APPROVED_MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  const config = loadEvaluatorConfig(dir);
  manifest.evaluator_components = componentHashes(config);
  manifest.evaluator_id = computeEvaluatorId(config);
  edit?.(manifest);
  writeFileSync(path, serializeManifest(manifest));
}

/** Rewrites the approved manifest's text; the edit must change it. */
function editManifestText(dir: string, edit: (text: string) => string): void {
  const path = join(dir, APPROVED_MANIFEST_PATH);
  const text = readFileSync(path, "utf8");
  const next = edit(text);
  expect(next).not.toBe(text);
  writeFileSync(path, next);
}

function writeCases(dir: string, cases: GoldenCase[]): void {
  writeFileSync(join(dir, CASES_PATH), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
}

/** Fresh temp repo: real instrument, synthetic corpus, approved manifest. */
function fixture(observations: Observation[] = observe(RUNS), edit?: (m: Manifest) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "judgelock-verify-"));
  fixtures.push(dir);
  for (const p of INSTRUMENT) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  mkdirSync(join(dir, "corpus", "docs"), { recursive: true });
  writeCases(dir, CASES);
  for (const [name, content] of Object.entries(DOCS)) {
    writeFileSync(join(dir, "corpus", "docs", name), content);
  }
  writeManifest(dir, observations, edit);
  return dir;
}

/** Failure set as "kind/subject" (or "kind" when there is no subject). */
function failures(result: VerifyResult): string[] {
  return result.failures.map((f) => (f.subject ? `${f.kind}/${f.subject}` : f.kind));
}

function editJson(path: string, edit: (value: Record<string, any>) => void): void {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  edit(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("verify: deliberate drift", () => {
  it("passes on an untouched fixture", () => {
    const result = verify({ root: fixture() });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rubric edit names rubric", () => {
    const dir = fixture();
    appendFileSync(join(dir, "rubric", "rubric.yaml"), "\n# drift\n");
    expect(failures(verify({ root: dir }))).toEqual(["evaluator_id_mismatch/rubric"]);
  });

  it("judge prompt edit names judge_prompt_template", () => {
    const dir = fixture();
    appendFileSync(join(dir, "prompts", "judge.txt"), "\nBe strict.\n");
    expect(failures(verify({ root: dir }))).toEqual([
      "evaluator_id_mismatch/judge_prompt_template",
    ]);
  });

  it("model_id edit names model_id", () => {
    const dir = fixture();
    editJson(join(dir, "evaluator.config.json"), (c) => {
      c.model_id = "gpt-5.4-2026-09-01";
    });
    expect(failures(verify({ root: dir }))).toEqual(["evaluator_id_mismatch/model_id"]);
  });

  it("reasoning_effort medium -> high names decoding", () => {
    const dir = fixture();
    editJson(join(dir, "evaluator.config.json"), (c) => {
      expect(c.decoding.reasoning_effort).toBe("medium");
      c.decoding.reasoning_effort = "high";
    });
    expect(failures(verify({ root: dir }))).toEqual(["evaluator_id_mismatch/decoding"]);
  });

  it("verdict schema properties reordered names output_schema", () => {
    const dir = fixture();
    editJson(join(dir, "schemas", "verdict.schema.json"), (s) => {
      s.properties = Object.fromEntries(Object.entries(s.properties).reverse());
    });
    expect(failures(verify({ root: dir }))).toEqual(["evaluator_id_mismatch/output_schema"]);
  });

  it("verdict schema description edit names output_schema", () => {
    const dir = fixture();
    editJson(join(dir, "schemas", "verdict.schema.json"), (s) => {
      s.description += " Edited.";
    });
    expect(failures(verify({ root: dir }))).toEqual(["evaluator_id_mismatch/output_schema"]);
  });

  it("scoring-path code edit names implementation_digest", () => {
    const dir = fixture();
    appendFileSync(join(dir, "src", "judge.ts"), "\n// drift\n");
    expect(failures(verify({ root: dir }))).toEqual([
      "evaluator_id_mismatch/implementation_digest",
    ]);
  });

  it("agent code edit does not move the evaluator", () => {
    const dir = fixture();
    appendFileSync(join(dir, "src", "agent.ts"), "\n// drift\n");
    expect(verify({ root: dir }).failures).toEqual([]);
  });

  it("rubric rewritten with CRLF and BOM does not move the evaluator", () => {
    const dir = fixture();
    const path = join(dir, "rubric", "rubric.yaml");
    writeFileSync(path, `﻿${readFileSync(path, "utf8").replace(/\n/g, "\r\n")}`);
    expect(verify({ root: dir }).failures).toEqual([]);
  });

  it("case question edit is a corpus change", () => {
    const dir = fixture();
    writeCases(dir, CASES.map((c, i) => (i === 0 ? { ...c, question: `${c.question}?` } : c)));
    expect(failures(verify({ root: dir }))).toEqual(["corpus_hash_mismatch"]);
  });

  it("reference doc edit is exactly a corpus change", () => {
    const dir = fixture();
    appendFileSync(join(dir, "corpus", "docs", "b-penalty.md"), "The penalty is permanent.\n");
    expect(failures(verify({ root: dir }))).toEqual(["corpus_hash_mismatch"]);
  });

  it("tampered stated agreement is a results mismatch", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.results.agreement = 0.99;
    });
    const result = verify({ root: dir });
    expect(failures(result)).toEqual(["results_mismatch/agreement"]);
    expect(result.failures[0]).toMatchObject({ expected: "0.99", actual: "1" });
  });

  it("tampered verdict label with raw unchanged is caught by reparse", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.raw_observations.find((o) => o.case_id === "case-pass")!.verdict.label = "incorrect";
    });
    expect(failures(verify({ root: dir }))).toContain("manifest_invalid/case-pass");
  });

  it("critical non-pass judged pass violates critical_miss_rate", () => {
    const result = verify({ root: fixture(observe(2, missCritical)) });
    expect(failures(result)).toContain("threshold_violation/critical_miss_rate");
  });

  it("single-run evidence fails the pinned runs and self_consistency", () => {
    expect(failures(verify({ root: fixture(observe(1)) }))).toEqual([
      "manifest_invalid",
      "threshold_violation/self_consistency",
    ]);
  });

  it("honest evidence at fewer runs than thresholds.json pins is exactly one manifest_invalid", () => {
    expect(RUNS).toBe(3);
    const result = verify({ root: fixture(observe(2)) });
    expect(failures(result)).toEqual(["manifest_invalid"]);
    expect(result.failures[0]!.detail).toBe(
      "evidence has 2 runs per case; validation/thresholds.json requires 3",
    );
  });

  it("loosened manifest thresholds are invalid", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.thresholds[0]!.bound = 0.5;
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("a different threshold_source is invalid", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.threshold_source = "validation/other-thresholds.json";
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("missing manifest is exactly one manifest_invalid", () => {
    const dir = fixture();
    rmSync(join(dir, APPROVED_MANIFEST_PATH));
    const result = verify({ root: dir });
    expect(failures(result)).toEqual(["manifest_invalid"]);
    expect(result.failures[0]!.detail).toContain("no approved manifest");
  });

  it("manifest failing the schema is exactly one manifest_invalid", () => {
    const dir = fixture(observe(RUNS), (m) => {
      delete (m as Partial<Manifest>).evaluator_components;
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("a case with its observations removed is named", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.raw_observations = m.raw_observations.filter((o) => o.case_id !== "case-standard");
      m.results = computeResults(m.raw_observations, CASES);
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid/case-standard"]);
  });

  it("tampered evaluator_components fail self-consistency and name the component", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.evaluator_components.rubric = "0".repeat(64);
    });
    expect(failures(verify({ root: dir }))).toEqual([
      "manifest_invalid",
      "evaluator_id_mismatch/rubric",
    ]);
  });

  it("tampered evaluator_id alone fails self-consistency and the id check", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.evaluator_id = "0".repeat(64);
    });
    expect(failures(verify({ root: dir }))).toEqual([
      "manifest_invalid",
      "evaluator_id_mismatch",
    ]);
  });

  it("an extra stated metric is a results mismatch", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.results.bogus = 1;
    });
    expect(failures(verify({ root: dir }))).toEqual(["results_mismatch/bogus"]);
  });

  it("evidence-only verdict tamper with raw unchanged is caught by reparse", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.raw_observations.find((o) => o.case_id === "case-pass")!.verdict.evidence = "edited";
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid/case-pass"]);
  });

  it("severity-only verdict tamper with raw unchanged is caught by reparse", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.raw_observations.find((o) => o.case_id === "case-pass")!.verdict.severity = "critical";
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid/case-pass"]);
  });

  it("gates on validation/thresholds.json, not the manifest's thresholds", () => {
    const dir = fixture(observe(2, missCritical), (m) => {
      m.thresholds.find((t) => t.metric === "critical_miss_rate")!.bound = 1;
    });
    const found = failures(verify({ root: dir }));
    expect(found).toContain("manifest_invalid");
    expect(found).toContain("threshold_violation/critical_miss_rate");
  });
});

describe("verify: request binding", () => {
  it("rubric edit with a re-stamped manifest is exactly request_mismatch", () => {
    const dir = fixture();
    appendFileSync(join(dir, "rubric", "rubric.yaml"), "\n# drift\n");
    restamp(dir);
    const result = verify({ root: dir });
    expect(failures(result)).toEqual(["request_mismatch"]);
    expect(result.failures[0]!.detail).toBe(
      `${CASES.length * RUNS} of ${CASES.length * RUNS} observations were judged with a request the working tree would not send; first: "case-critical", "case-pass", "case-standard", "case-unsupported"`,
    );
  });

  it("schema properties reordered with a re-stamped manifest is exactly request_mismatch", () => {
    const dir = fixture();
    editJson(join(dir, "schemas", "verdict.schema.json"), (s) => {
      s.properties = Object.fromEntries(Object.entries(s.properties).reverse());
    });
    restamp(dir);
    expect(failures(verify({ root: dir }))).toEqual(["request_mismatch"]);
  });

  it("model swap fully re-stamped, resolved_model_id included, is exactly request_mismatch", () => {
    const dir = fixture();
    editJson(join(dir, "evaluator.config.json"), (c) => {
      c.model_id = "gpt-5.4-2026-09-01";
    });
    restamp(dir, (m) => {
      m.resolved_model_id = "gpt-5.4-2026-09-01";
    });
    expect(failures(verify({ root: dir }))).toEqual(["request_mismatch"]);
  });

  it("one forged observation hash is counted and named", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.raw_observations.find((o) => o.case_id === "case-standard")!.request_sha256 = "f".repeat(64);
    });
    const result = verify({ root: dir });
    expect(failures(result)).toEqual(["request_mismatch"]);
    expect(result.failures[0]!.detail).toBe(
      `1 of ${CASES.length * RUNS} observations were judged with a request the working tree would not send; first: "case-standard"`,
    );
  });
});

describe("verify: resolved_model_id", () => {
  it("resolved_model_id that is not the model_id component's model is manifest_invalid", () => {
    const dir = fixture();
    const served = loadEvaluatorConfig(dir).model_id;
    editJson(join(dir, "evaluator.config.json"), (c) => {
      c.model_id = "gpt-5.4-2026-09-01";
    });
    // Components, id and request hashes all re-stamped to the new model; only
    // resolved_model_id still names the old one.
    writeManifest(dir, observe(RUNS), (m) => {
      m.resolved_model_id = served;
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid/resolved_model_id"]);
  });

  it("empty resolved_model_id is caught", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.resolved_model_id = "";
    });
    expect(failures(verify({ root: dir }))).toContain("manifest_invalid/resolved_model_id");
  });
});

describe("verify: canonical form", () => {
  it("duplicate results key is rejected", () => {
    const dir = fixture();
    // JSON.parse keeps the last key, so the reviewed first one would be ignored.
    editManifestText(dir, (t) =>
      t.replace('"results": {', '"results": {\n    "agreement": 0.1\n  },\n  "results": {'),
    );
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("__proto__ in evaluator_components is rejected", () => {
    const dir = fixture();
    editManifestText(dir, (t) =>
      t.replace('"evaluator_components": {', '"evaluator_components": {\n    "__proto__": "x",'),
    );
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("extra top-level field is rejected", () => {
    const dir = fixture();
    editManifestText(dir, (t) => t.replace(/^\{\n/, '{\n  "note": "hand edit",\n'));
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("-0 in results is rejected", () => {
    const dir = fixture();
    editManifestText(dir, (t) =>
      t.replace('"critical_miss_rate": 0,', '"critical_miss_rate": -0,'),
    );
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("reordered keys are rejected", () => {
    const dir = fixture();
    editManifestText(
      dir,
      (t) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(t)).reverse()), null, 2) + "\n",
    );
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("observations out of canonical order are rejected", () => {
    const dir = fixture(observe(RUNS), (m) => {
      m.raw_observations.reverse();
    });
    expect(failures(verify({ root: dir }))).toEqual(["manifest_invalid"]);
  });

  it("a CRLF + BOM copy of a canonical manifest passes", () => {
    const dir = fixture();
    editManifestText(dir, (t) => `﻿${t.replace(/\n/g, "\r\n")}`);
    expect(verify({ root: dir }).failures).toEqual([]);
  });
});

describe("buildManifest", () => {
  const input = () => ({
    config: loadEvaluatorConfig(ROOT),
    cases: CASES,
    documents: Object.entries(DOCS).map(([filename, content]) => ({ filename, content })),
    resolvedModelId: "gpt-5.4-2026-03-05",
    thresholds: loadThresholds(ROOT),
  });

  it("throws on a missing observation", () => {
    const observations = observe(2).filter(
      (o) => !(o.case_id === "case-standard" && o.run_index === 1),
    );
    expect(() => buildManifest({ ...input(), observations })).toThrow(
      /"case-standard" has 1 runs/,
    );
  });

  it("orders observations by case_id code unit, then run_index", () => {
    const m = buildManifest({ ...input(), observations: observe(2).reverse() });
    expect(m.raw_observations.map((o) => `${o.case_id}#${o.run_index}`)).toEqual([
      "case-critical#0",
      "case-critical#1",
      "case-pass#0",
      "case-pass#1",
      "case-standard#0",
      "case-standard#1",
      "case-unsupported#0",
      "case-unsupported#1",
    ]);
  });
});

describe("loadCorpus", () => {
  it("rejects a case labeled invalid_judge_output", () => {
    const dir = mkdtempSync(join(tmpdir(), "judgelock-corpus-"));
    fixtures.push(dir);
    const path = join(dir, "cases.jsonl");
    writeFileSync(path, `${JSON.stringify({ ...CASES[0], human_label: "invalid_judge_output" })}\n`);
    expect(() => loadCorpus(path)).toThrow(/human_label/);
  });

  it("rejects a pass case with critical severity", () => {
    const dir = mkdtempSync(join(tmpdir(), "judgelock-corpus-"));
    fixtures.push(dir);
    const path = join(dir, "cases.jsonl");
    writeFileSync(path, `${JSON.stringify({ ...CASES[0], human_label: "pass", human_severity: "critical" })}\n`);
    expect(() => loadCorpus(path)).toThrow(
      "corpus line 1: case case-pass is labeled pass with severity critical; the rubric always uses standard for pass",
    );
  });
});

describe("checkThresholds", () => {
  const MIN = [{ metric: "agreement", direction: "min" as const, bound: 0.85 }];
  const MAX = [{ metric: "critical_miss_rate", direction: "max" as const, bound: 0 }];

  it("min bound is inclusive", () => {
    expect(checkThresholds({ agreement: 0.85 }, MIN)).toEqual([]);
  });

  it("max bound is inclusive", () => {
    expect(checkThresholds({ critical_miss_rate: 0 }, MAX)).toEqual([]);
  });

  it("fails just below a min bound", () => {
    expect(checkThresholds({ agreement: 0.8499 }, MIN)).toMatchObject([
      { kind: "threshold_violation", subject: "agreement" },
    ]);
  });

  it("fails just above a max bound", () => {
    expect(checkThresholds({ critical_miss_rate: 0.01 }, MAX)).toMatchObject([
      { kind: "threshold_violation", subject: "critical_miss_rate" },
    ]);
  });

  it("fails on an absent metric", () => {
    expect(checkThresholds({}, MIN)).toEqual([
      {
        kind: "threshold_violation",
        subject: "agreement",
        detail: "metric agreement was not computed",
      },
    ]);
  });
});

describe("computeResults", () => {
  const mk = (id: string, human_label: GoldenCase["human_label"], human_severity: GoldenCase["human_severity"]): GoldenCase =>
    ({ id, question: "q", answer: "a", human_label, human_severity });
  const obs = (case_id: string, labels: Verdict["label"][]): Observation[] =>
    labels.map((label, run_index) => ({
      case_id,
      run_index,
      request_sha256: "0".repeat(64),
      verdict: { label, severity: "standard", evidence: "" },
      raw_judge_response: "",
      response: { id: "", finish_reason: "stop", refusal: null },
    }));

  it("matches a hand-computed example", () => {
    const cases = [
      mk("A", "pass", "standard"),
      mk("B", "incorrect", "critical"),
      mk("C", "unsupported", "critical"),
      mk("D", "incomplete", "standard"),
      mk("E", "pass", "critical"),
    ];
    const observations = [
      ...obs("A", ["pass", "pass"]),
      ...obs("B", ["incorrect", "pass"]),
      ...obs("C", ["pass", "pass"]),
      ...obs("D", ["invalid_judge_output", "pass"]),
      ...obs("E", ["pass", "pass"]),
    ];
    // agreement: A 2 + B 1 + C 0 + D 0 + E 2 = 5 of 10 observations.
    // critical_miss_rate: critical non-pass cases are B and C (E is pass, D is
    //   standard): 4 observations, 3 judged pass (B run 1, C both).
    // invalid_output_rate: 1 of 10 (D run 0).
    // self_consistency: A, C, E single-label; B, D mixed: 3 of 5 cases.
    // false_pass_rate: non-pass cases B, C, D: 6 observations, 4 judged pass
    //   (B run 1, C both, D run 1).
    // severity_agreement: non-pass observations judged neither pass nor
    //   invalid: only B run 0 (severity standard vs human critical): 0 of 1.
    expect(computeResults(observations, cases)).toStrictEqual({
      agreement: 0.5,
      critical_miss_rate: 0.75,
      invalid_output_rate: 0.1,
      self_consistency: 0.6,
      false_pass_rate: 4 / 6,
      severity_agreement: 0,
    });
  });

  it("report-only metrics match a hand-computed example", () => {
    const sv = (case_id: string, verdicts: [Verdict["label"], Verdict["severity"]][]): Observation[] =>
      verdicts.map(([label, severity], run_index) => ({
        ...obs(case_id, [label])[0]!,
        run_index,
        verdict: { label, severity, evidence: "" },
      }));
    const cases = [
      mk("P", "pass", "standard"),
      mk("X", "incorrect", "critical"),
      mk("Y", "unsupported", "standard"),
      mk("Z", "incomplete", "critical"),
    ];
    const observations = [
      ...sv("P", [["pass", "standard"], ["pass", "standard"], ["incorrect", "critical"]]),
      ...sv("X", [["incorrect", "critical"], ["pass", "standard"], ["unsupported", "standard"]]),
      ...sv("Y", [["unsupported", "standard"], ["invalid_judge_output", "standard"], ["pass", "standard"]]),
      ...sv("Z", [["incomplete", "standard"], ["incomplete", "critical"], ["incorrect", "critical"]]),
    ];
    // agreement: P 2 + X 1 + Y 1 + Z 2 = 6 of 12.
    // critical_miss_rate: X and Z, 6 observations, 1 judged pass (X run 1).
    // invalid_output_rate: 1 of 12 (Y run 1).
    // self_consistency: every case mixed: 0 of 4.
    // false_pass_rate: P excluded (human pass); X, Y, Z are 9 observations,
    //   2 judged pass (X run 1, Y run 2): 2/9.
    // severity_agreement: X0 (critical = critical, yes), X2 (standard vs
    //   critical, no), Y0 (standard = standard, yes), Z0 (standard vs critical,
    //   no), Z1 (yes), Z2 (yes). Y1 invalid and X1, Y2 pass are excluded, and P
    //   is excluded although its run 2 is a non-pass label: 4 of 6.
    expect(computeResults(observations, cases)).toStrictEqual({
      agreement: 0.5,
      critical_miss_rate: 1 / 6,
      invalid_output_rate: 1 / 12,
      self_consistency: 0,
      false_pass_rate: 2 / 9,
      severity_agreement: 4 / 6,
    });

    // Every non-pass observation judged pass: severity_agreement has no
    // denominator and is omitted; false_pass_rate is 1.
    expect(computeResults(obs("X", ["pass"]), [mk("X", "incorrect", "critical")])).toStrictEqual({
      agreement: 0,
      critical_miss_rate: 1,
      invalid_output_rate: 0,
      false_pass_rate: 1,
    });
  });

  it("omits metrics whose denominator is zero", () => {
    const cases = [mk("A", "pass", "standard")];
    // One run: no self_consistency. No critical non-pass case: no critical_miss_rate.
    expect(computeResults(obs("A", ["pass"]), cases)).toStrictEqual({
      agreement: 1,
      invalid_output_rate: 0,
    });
    expect(computeResults([], cases)).toStrictEqual({});
  });

  it("throws on an observation for an unknown case", () => {
    expect(() => computeResults(obs("Z", ["pass"]), [mk("A", "pass", "standard")])).toThrow(
      /unknown case Z/,
    );
  });
});

describe("checkCoverage", () => {
  const cases: GoldenCase[] = ["A", "B"].map((id) => ({
    id,
    question: "q",
    answer: "a",
    human_label: "pass",
    human_severity: "standard",
  }));
  const ob = (case_id: string, run_index: number): Observation => ({
    case_id,
    run_index,
    request_sha256: "0".repeat(64),
    verdict: { label: "pass", severity: "standard", evidence: "" },
    raw_judge_response: "",
    response: { id: "", finish_reason: "stop", refusal: null },
  });

  it("is clean on exact coverage", () => {
    expect(checkCoverage([ob("A", 0), ob("A", 1), ob("B", 1), ob("B", 0)], cases)).toEqual([]);
  });

  it("names an observation for an unknown case", () => {
    expect(checkCoverage([ob("A", 0), ob("B", 0), ob("Z", 0)], cases)).toEqual([
      { case_id: "Z", detail: expect.stringContaining('unknown case "Z"') },
    ]);
  });

  it("names a case with no observations", () => {
    expect(checkCoverage([ob("A", 0)], cases)).toEqual([
      { case_id: "B", detail: expect.stringContaining("no observations") },
    ]);
  });

  it("names a duplicate run_index", () => {
    expect(checkCoverage([ob("A", 0), ob("A", 0), ob("B", 0), ob("B", 1)], cases)).toEqual([
      { case_id: "A", detail: expect.stringContaining("duplicate run_index 0") },
    ]);
  });

  it("names run indices that are not 0..n-1", () => {
    expect(checkCoverage([ob("A", 0), ob("A", 1), ob("B", 1), ob("B", 2)], cases)).toEqual([
      { case_id: "B", detail: expect.stringContaining("run indices [1, 2]") },
    ]);
  });

  it("names a case whose run count differs", () => {
    expect(checkCoverage([ob("A", 0), ob("A", 1), ob("B", 0)], cases)).toEqual([
      { case_id: "B", detail: expect.stringContaining('case "B" has 1 runs but case "A" has 2') },
    ]);
  });
});

describe("formatVerifyResult", () => {
  it("renders PASS", () => {
    expect(
      formatVerifyResult({ ok: true, evaluator_id: "e1", corpus_hash: "c1", failures: [] }),
    ).toBe("judgelock verify: PASS\nevaluator_id e1\ncorpus_hash c1");
  });

  it("renders FAIL with one block per failure", () => {
    const out = formatVerifyResult({
      ok: false,
      evaluator_id: "e2",
      corpus_hash: "c2",
      failures: [
        {
          kind: "evaluator_id_mismatch",
          subject: "rubric",
          detail: "rubric changed since approval",
          expected: "aaa",
          actual: "bbb",
        },
        {
          kind: "results_mismatch",
          subject: "agreement",
          detail: "agreement differs",
          expected: "0.99",
          actual: "1",
        },
        { kind: "manifest_invalid", detail: "no approved manifest" },
      ],
    });
    expect(out).toBe(
      [
        "judgelock verify: FAIL (3 problems)",
        "evaluator_id e2",
        "corpus_hash c2",
        "",
        "[evaluator_id_mismatch] rubric changed since approval",
        "  approved: aaa",
        "  working: bbb",
        "",
        "[results_mismatch] agreement differs",
        "  stated: 0.99",
        "  recomputed: 1",
        "",
        "[manifest_invalid] no approved manifest",
      ].join("\n"),
    );
  });
});
