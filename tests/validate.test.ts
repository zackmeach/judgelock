import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
  loadEvaluatorRuntimeConfig,
  loadReferenceDocuments,
  loadThresholds,
} from "../src/config.ts";
import type { JudgeResponse } from "../src/judge.ts";
import { renderReport } from "../src/report.ts";
import type { GoldenCase, Manifest, Observation, Verdict } from "../src/types.ts";
import { buildManifest, serializeManifest, validate, type JudgeFn } from "../src/validate.ts";
import { verify } from "../src/verify.ts";
import { ROOT } from "./root.ts";

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

/** verify requires resolved_model_id to be the configured (pinned) model_id. */
const MODEL = loadEvaluatorRuntimeConfig(ROOT).model_id;

/** Synthetic corpus: the suite never depends on the real golden set. */
const CASES: GoldenCase[] = [
  { id: "case-pass", question: "q1", answer: "a1", human_label: "pass", human_severity: "standard" },
  { id: "case-critical", question: "q2", answer: "a2", human_label: "incorrect", human_severity: "critical" },
  { id: "case-standard", question: "q3", answer: "a3", human_label: "incomplete", human_severity: "standard" },
  { id: "case-unsupported", question: "q4", answer: "a4", human_label: "unsupported", human_severity: "critical" },
];

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp repo: real instrument, synthetic corpus, no approved manifest. */
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "judgelock-validate-"));
  fixtures.push(dir);
  for (const p of INSTRUMENT) cpSync(join(ROOT, p), join(dir, p), { recursive: true });
  mkdirSync(join(dir, "corpus", "docs"), { recursive: true });
  writeFileSync(join(dir, CASES_PATH), CASES.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(join(dir, "corpus", "docs", "a.md"), "# A\nThe initial enrollment period is 7 months.\n");
  return dir;
}

const honestRaw = (c: GoldenCase): string =>
  JSON.stringify({ label: c.human_label, severity: c.human_severity, evidence: "x" });

/** Fake judge: records every call; `respond` decides the response per case. */
function fakeJudge(respond: (c: GoldenCase) => Promise<JudgeResponse> | JudgeResponse = (c) => ({
  raw: honestRaw(c),
  resolved_model_id: MODEL,
})) {
  const calls: { caseId: string; provider: string | undefined }[] = [];
  const judge: JudgeFn = async (_config, _documents, testCase, options) => {
    calls.push({ caseId: testCase.id, provider: options?.provider });
    return respond(testCase);
  };
  return { judge, calls };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("validate", () => {
  it("honest judge, runs=2: full sorted coverage, and the manifest verifies", async () => {
    const dir = fixture();
    const { judge, calls } = fakeJudge();
    const manifest = await validate({ root: dir, runs: 2, judge });

    expect(calls).toHaveLength(8);
    expect(calls.every((c) => c.provider === "openai")).toBe(true);
    expect(manifest.raw_observations.map((o) => `${o.case_id}/${o.run_index}`)).toEqual([
      "case-critical/0",
      "case-critical/1",
      "case-pass/0",
      "case-pass/1",
      "case-standard/0",
      "case-standard/1",
      "case-unsupported/0",
      "case-unsupported/1",
    ]);
    expect(manifest.resolved_model_id).toBe(MODEL);

    writeFileSync(join(dir, APPROVED_MANIFEST_PATH), serializeManifest(manifest));
    const result = verify({ root: dir });
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("records non-JSON judge output as invalid_judge_output, byte for byte", async () => {
    const raw = '  \tnot json\r\n{"label": "pass"}\rtrailing\n  ';
    const { judge } = fakeJudge((c) => ({
      raw: c.id === "case-standard" ? raw : honestRaw(c),
      resolved_model_id: MODEL,
    }));
    const manifest = await validate({ root: fixture(), runs: 1, judge });
    const bad = manifest.raw_observations.find((o) => o.case_id === "case-standard")!;
    expect(bad.verdict.label).toBe("invalid_judge_output");
    expect(bad.raw_judge_response).toBe(raw);
    // And through the candidate's serialized form.
    const reread = JSON.parse(serializeManifest(manifest)) as Manifest;
    expect(reread.raw_observations.find((o) => o.case_id === "case-standard")!.raw_judge_response).toBe(raw);
    expect(manifest.results.invalid_output_rate).toBeGreaterThan(0);
  });

  it("rejects when the served model changes mid-run, naming both ids", async () => {
    const { judge } = fakeJudge((c) => ({
      raw: honestRaw(c),
      resolved_model_id: c.id === "case-unsupported" ? "model-b" : "model-a",
    }));
    await expect(validate({ root: fixture(), runs: 1, judge })).rejects.toThrow(
      /"model-a", "model-b"/,
    );
  });

  it("rejects a consistent served model that is not the configured model_id", async () => {
    const { judge } = fakeJudge((c) => ({ raw: honestRaw(c), resolved_model_id: "gpt-5.4" }));
    await expect(validate({ root: fixture(), runs: 1, judge })).rejects.toThrow(
      `judge API served "gpt-5.4" but the configured model_id is ${JSON.stringify(MODEL)}`,
    );
  });

  it.each(["", "  \t"])("rejects a response reporting no served model (%j)", async (served) => {
    const { judge } = fakeJudge((c) => ({
      raw: honestRaw(c),
      resolved_model_id: c.id === "case-standard" ? served : MODEL,
    }));
    await expect(validate({ root: fixture(), runs: 1, judge })).rejects.toThrow(
      /reported no served model on case case-standard run 0/,
    );
  });

  it("aborts on a judge rejection without starting further jobs", async () => {
    const pending: (() => void)[] = [];
    const { judge, calls } = fakeJudge(async (c) => {
      if (c.id === "case-critical") throw new Error("boom");
      await new Promise<void>((r) => pending.push(r));
      return { raw: honestRaw(c), resolved_model_id: MODEL };
    });

    // Jobs in order: case-pass r0, case-pass r1, case-critical r0, ... (8 total).
    await expect(validate({ root: fixture(), runs: 2, judge, concurrency: 3 })).rejects.toThrow(
      /case case-critical run 0: boom/,
    );
    const startedAtFailure = calls.length;
    expect(startedAtFailure).toBe(3);

    // Let the in-flight calls finish; their workers must not pick up new jobs.
    for (const release of pending.splice(0)) release();
    for (let i = 0; i < 5; i++) await tick();
    expect(calls).toHaveLength(startedAtFailure);
  });

  it("a throwing onObservation stops the pool", async () => {
    const { judge, calls } = fakeJudge();
    let seen = 0;
    await expect(
      validate({
        root: fixture(),
        runs: 2,
        judge,
        concurrency: 2,
        onObservation: () => {
          if (seen++ === 0) throw new Error("observer failed");
        },
      }),
    ).rejects.toThrow("observer failed");
    for (let i = 0; i < 5; i++) await tick();
    // Only the two calls in flight when the observer threw; 8 if the pool kept going.
    expect(calls).toHaveLength(2);
  });

  it.each([0, 1.5, Number.NaN, -1])("rejects runs=%s before any judge call", async (runs) => {
    const { judge, calls } = fakeJudge();
    await expect(validate({ root: fixture(), runs, judge })).rejects.toThrow(
      /runs must be an integer >= 1/,
    );
    expect(calls).toHaveLength(0);
  });

  it("never has more than `concurrency` judge calls in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { judge, calls } = fakeJudge(async (c) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1 + (c.id.length % 4)));
      inFlight--;
      return { raw: honestRaw(c), resolved_model_id: MODEL };
    });
    const progress: string[] = [];
    await validate({
      root: fixture(),
      runs: 3,
      judge,
      concurrency: 3,
      onObservation: (_o, done, total) => progress.push(`${done}/${total}`),
    });
    expect(calls).toHaveLength(12);
    expect(maxInFlight).toBe(3);
    expect(progress.at(-1)).toBe("12/12");
  });
});

describe("renderReport", () => {
  /** Manifest over the fixture with per-case scripted verdicts, one per run. */
  function scripted(dir: string, script: Record<string, Verdict[]>): Manifest {
    const observations: Observation[] = Object.entries(script).flatMap(([case_id, verdicts]) =>
      verdicts.map((verdict, run_index) => ({
        case_id,
        run_index,
        verdict,
        raw_judge_response: JSON.stringify(verdict),
      })),
    );
    return buildManifest({
      config: loadEvaluatorConfig(dir),
      cases: loadCorpus(join(dir, CASES_PATH)),
      documents: loadReferenceDocuments(dir),
      observations,
      resolvedModelId: MODEL,
      thresholds: loadThresholds(dir),
    });
  }
  const honest = (c: GoldenCase): Verdict => ({
    label: c.human_label,
    severity: c.human_severity,
    evidence: "x",
  });
  const byId = (id: string): GoldenCase => CASES.find((c) => c.id === id)!;
  const render = (manifest: Manifest): string =>
    renderReport({
      manifest,
      cases: CASES,
      runs: 2,
      configuredModelId: MODEL,
      generatedAt: new Date("2026-10-05T12:00:00Z"),
      candidateSha256: "c0ffee",
    });

  it("renders thresholds, a disagreement with a piped evidence cell, and a split", () => {
    const dir = fixture();
    const wrong: Verdict = { label: "pass", severity: "standard", evidence: "a | b\nc\\|d" };
    const manifest = scripted(dir, {
      "case-pass": [honest(byId("case-pass")), honest(byId("case-pass"))],
      "case-critical": [honest(byId("case-critical")), honest(byId("case-critical"))],
      // Disagrees on both runs: a disagreement, not a split.
      "case-standard": [wrong, wrong],
      // Disagrees on run 1 only: a split (and therefore also a disagreement).
      "case-unsupported": [
        honest(byId("case-unsupported")),
        { label: "incorrect", severity: "critical", evidence: "<script>alert(1)</script>" },
      ],
    });
    const out = render(manifest);
    const lines = out.split("\n");

    expect(out).toContain("- candidate sha256: `c0ffee`");
    expect(out).toContain("| metric | value | bound | result |");
    // agreement 5/8; self_consistency 3/4 (case-unsupported split).
    expect(out).toContain("| agreement | 0.625 | min 0.85 | FAIL |");
    expect(out).toContain("| critical_miss_rate | 0 | max 0 | PASS |");
    expect(out).toContain("| self_consistency | 0.75 | min 0.9 | FAIL |");
    expect(out).toContain("**Verdict:** fails 2 threshold(s) — do not promote.");

    // Backslash escaped before the pipe: `c\|d` renders as c\\\|d, not an escaped-escape.
    const row = lines.filter((l) => l.startsWith("| case-standard |"));
    expect(row).toEqual(["| case-standard | incomplete / standard | pass, pass | a \\| b c\\\\\\|d |"]);
    // Four cells: exactly five unescaped pipes.
    expect(row[0]!.split(/(?<!\\)\|/)).toHaveLength(6);

    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script>alert(1)&lt;/script>");

    const splits = out.slice(out.indexOf("## Split verdicts"), out.indexOf("## Invalid judge outputs"));
    expect(splits).toContain("| case-unsupported | unsupported / critical | unsupported, incorrect |");
    expect(splits).not.toContain("case-standard");
    expect(out.slice(out.indexOf("## Invalid judge outputs"))).toContain("None.");
  });

  it("an honest multi-run candidate is eligible for promotion", () => {
    const dir = fixture();
    const manifest = scripted(
      dir,
      Object.fromEntries(CASES.map((c) => [c.id, [honest(c), honest(c)]])),
    );
    const out = render(manifest);
    expect(out).toContain("**Verdict:** meets every threshold — eligible for promotion.");
    expect(out.slice(out.indexOf("## Disagreements"))).toMatch(/## Disagreements\n\nNone\./);
  });
});

describe("cli validate", () => {
  /** Spawns the CLI keyless: no test here may reach the network. */
  function cli(dir: string, ...args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: "" };
    delete env.ANTHROPIC_API_KEY;
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", join(ROOT, "src", "cli.ts"), "validate", "--root", dir, ...args],
      { encoding: "utf8", env },
    );
  }
  const candidate = (dir: string): string => join(dir, "validation", "candidate-manifest.json");
  const reports = (dir: string): string[] => {
    const path = join(dir, "validation", "reports");
    return existsSync(path) ? readdirSync(path) : [];
  };

  it.each(["0", "11", "0x2", "1.5"])("--runs %s exits 1 before any call and writes nothing", (runs) => {
    const dir = fixture();
    const result = cli(dir, "--runs", runs);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--runs must be an integer from 1 to 10, got "${runs}"`);
    expect(existsSync(candidate(dir))).toBe(false);
    expect(reports(dir)).toEqual([]);
  });

  const approvedSpellings = [
    "validation/approved-manifest.json",
    "./validation/../validation/approved-manifest.json",
    ...(process.platform === "win32" ? ["VALIDATION/Approved-Manifest.JSON"] : []),
  ];
  it.each(approvedSpellings)("--out %s is refused before any call", (out) => {
    const dir = fixture();
    const result = cli(dir, "--out", out);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--out must not be validation/approved-manifest.json");
    expect(result.stderr).not.toContain("judge call failed");
    expect(existsSync(join(dir, APPROVED_MANIFEST_PATH))).toBe(false);
    expect(reports(dir)).toEqual([]);
  });

  it("without an API key exits 1 and writes no candidate or report", () => {
    const dir = fixture();
    const result = cli(dir, "--runs", "2");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OPENAI_API_KEY is not set");
    expect(existsSync(candidate(dir))).toBe(false);
    expect(reports(dir)).toEqual([]);
  });
});
