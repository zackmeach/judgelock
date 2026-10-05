import { describe, expect, it } from "vitest";
import { loadEvaluatorConfig, loadReferenceDocuments } from "../src/config.ts";
import { parseVerdict, renderDocuments, renderPrompt } from "../src/judge.ts";
import type { ReferenceDocument } from "../src/types.ts";
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
  });

  it("renders the real template, rubric, and docs with no placeholder left", () => {
    const config = loadEvaluatorConfig(ROOT);
    const real = renderPrompt(config.judge_prompt_template, {
      ...VALUES,
      rubric: config.rubric,
      documents: renderDocuments(loadReferenceDocuments(ROOT)),
    });
    expect(real).toContain(config.rubric);
    expect(real).not.toContain("{{");
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

  it("throws on near-miss placeholder names instead of passing them through", () => {
    expect(() => renderPrompt(`${TEMPLATE} {{ question }}`, VALUES)).toThrow(
      /unknown placeholder \{\{ question \}\}/,
    );
    expect(() => renderPrompt(`${TEMPLATE} {{doc-uments}}`, VALUES)).toThrow(
      /unknown placeholder \{\{doc-uments\}\}/,
    );
  });
});

describe("renderDocuments", () => {
  const DOCS: ReferenceDocument[] = [
    { filename: "a.md", content: "# A\nline one\n" },
    { filename: "b.md", content: "# B\nPart B is $202.90.\n" },
  ];

  it("wraps each document in a filename-tagged block", () => {
    expect(renderDocuments(DOCS)).toBe(
      '<document filename="a.md">\n# A\nline one\n\n</document>\n\n' +
        '<document filename="b.md">\n# B\nPart B is $202.90.\n\n</document>',
    );
  });

  it("is independent of input order", () => {
    expect(renderDocuments([...DOCS].reverse())).toBe(renderDocuments(DOCS));
  });

  it("renders CRLF content identically to LF", () => {
    const crlf = DOCS.map((d) => ({ ...d, content: d.content.replace(/\n/g, "\r\n") }));
    expect(renderDocuments(crlf)).toBe(renderDocuments(DOCS));
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
