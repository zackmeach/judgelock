import { describe, expect, it } from "vitest";
import { loadEvaluatorConfig } from "../src/config.ts";
import { parseVerdict, renderPrompt } from "../src/judge.ts";
import { ROOT } from "./root.ts";

const TEMPLATE =
  "R:{{rubric}}\nD:{{documents}}\nQ:{{question}}\nA:{{answer}}";
const VALUES = {
  rubric: "rubric",
  documents: "docs",
  question: "question",
  answer: "answer",
};

describe("renderPrompt", () => {
  it("inserts $ replacement patterns verbatim", () => {
    const answer = "Part B is $202.90; $& $' $` $1 $$ stay literal.";
    const out = renderPrompt(TEMPLATE, { ...VALUES, answer });
    expect(out).toBe(`R:rubric\nD:docs\nQ:question\nA:${answer}`);
  });

  it("does not re-scan inserted text", () => {
    const question = "What does {{answer}} mean?";
    const out = renderPrompt(TEMPLATE, { ...VALUES, question });
    expect(out).toBe(
      "R:rubric\nD:docs\nQ:What does {{answer}} mean?\nA:answer",
    );
  });

  it("inserts a rubric containing {{rubric}} literally", () => {
    const out = renderPrompt(TEMPLATE, { ...VALUES, rubric: "see {{rubric}}" });
    expect(out).toContain("R:see {{rubric}}\n");

    const config = loadEvaluatorConfig(ROOT);
    expect(config.rubric).toContain("{{rubric}}");
    const real = renderPrompt(config.judge_prompt_template, {
      ...VALUES,
      rubric: config.rubric,
    });
    expect(real).toContain(config.rubric);
  });

  it("throws when the template is missing {{documents}}", () => {
    expect(() =>
      renderPrompt("{{rubric}} {{question}} {{answer}}", VALUES),
    ).toThrow(/missing \{\{documents\}\}/);
  });

  it("throws on an unknown placeholder", () => {
    expect(() => renderPrompt(`${TEMPLATE} {{foo}}`, VALUES)).toThrow(
      /unknown placeholder \{\{foo\}\}/,
    );
  });
});

describe("parseVerdict", () => {
  it("parses a valid judge JSON response", () => {
    const verdict = parseVerdict(
      JSON.stringify({
        label: "pass",
        severity: "standard",
        evidence: "Matches the documented GEP dates.",
      }),
    );
    expect(verdict.label).toBe("pass");
    expect(verdict.severity).toBe("standard");
    expect(verdict.evidence).toContain("GEP");
  });

  it("returns invalid_judge_output for malformed JSON", () => {
    const verdict = parseVerdict("not json");
    expect(verdict.label).toBe("invalid_judge_output");
  });

  it("returns invalid_judge_output for schema violations", () => {
    const verdict = parseVerdict(
      JSON.stringify({ label: "pass", severity: "bogus", evidence: "" }),
    );
    expect(verdict.label).toBe("invalid_judge_output");
  });

  it("returns invalid_judge_output when the judge emits the harness label", () => {
    const verdict = parseVerdict(
      JSON.stringify({
        label: "invalid_judge_output",
        severity: "standard",
        evidence: "",
      }),
    );
    expect(verdict.label).toBe("invalid_judge_output");
  });
});
