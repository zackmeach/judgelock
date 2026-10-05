import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEvaluatorConfig, loadReferenceDocuments } from "../src/config.ts";
import {
  buildJudgeRequest,
  callJudge,
  judgeWireSchema,
  parseVerdict,
  renderDocuments,
  renderPrompt,
  requestSha256,
} from "../src/judge.ts";
import type { GoldenCase, ReferenceDocument } from "../src/types.ts";
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

  it("returns exactly the harness verdict when the judge emits the harness label", () => {
    // Severity and evidence differ from the harness verdict, so a passthrough
    // of the judge's own fields would fail the deep-equal.
    const verdict = parseVerdict(
      JSON.stringify({
        label: "invalid_judge_output",
        severity: "critical",
        evidence: "judge-written evidence",
      }),
    );
    expect(verdict).toStrictEqual({
      label: "invalid_judge_output",
      severity: "standard",
      evidence: "",
    });
  });
});

describe("judgeWireSchema", () => {
  it("drops invalid_judge_output from the label enum without mutating the input", () => {
    const schema = {
      type: "object",
      properties: {
        label: { type: "string", enum: ["pass", "invalid_judge_output", "incorrect"] },
        severity: { type: "string", enum: ["critical", "standard"] },
      },
    };
    const before = structuredClone(schema);
    const wire = judgeWireSchema(schema);
    expect(wire).toStrictEqual({
      type: "object",
      properties: {
        label: { type: "string", enum: ["pass", "incorrect"] },
        severity: { type: "string", enum: ["critical", "standard"] },
      },
    });
    expect(schema).toStrictEqual(before);
  });
});

describe("buildJudgeRequest", () => {
  const testCase: GoldenCase = {
    id: "c1",
    question: "When does Part B start?",
    answer: "The first of the month.",
    human_label: "pass",
    human_severity: "standard",
  };

  it("sends the schema in file order; reordering properties changes the hash", () => {
    const config = loadEvaluatorConfig(ROOT);
    const documents = loadReferenceDocuments(ROOT);
    const request = buildJudgeRequest(config, documents, testCase);
    const wire = request.response_format as { json_schema: { schema: Record<string, unknown> } };
    expect(Object.keys(wire.json_schema.schema)).toEqual(
      Object.keys(config.output_schema as Record<string, unknown>),
    );

    // Reordering schema properties changes the request hash.
    const schema = config.output_schema as { properties: Record<string, unknown> };
    const reordered = {
      ...config,
      output_schema: {
        ...schema,
        properties: Object.fromEntries(Object.entries(schema.properties).reverse()),
      },
    };
    expect(requestSha256(buildJudgeRequest(reordered, documents, testCase))).not.toBe(
      requestSha256(request),
    );
  });
});

describe("callJudge (openai)", () => {
  const saved = { key: process.env.OPENAI_API_KEY, base: process.env.OPENAI_BASE_URL };
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [name, value] of [["OPENAI_API_KEY", saved.key], ["OPENAI_BASE_URL", saved.base]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("sends exactly buildJudgeRequest's bytes and maps id, finish_reason and refusal", async () => {
    // No network: fetch is stubbed, and the base URL points at a closed local
    // port in case the stub were ever bypassed.
    process.env.OPENAI_API_KEY = "sk-test-not-a-real-key";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:9/v1";
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
      bodies.push(init.body);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "served-model",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              logprobs: null,
              message: { role: "assistant", content: null, refusal: "I can't help with that." },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const config = loadEvaluatorConfig(ROOT);
    const documents = loadReferenceDocuments(ROOT);
    const testCase: GoldenCase = {
      id: "c1",
      question: "q",
      answer: "a",
      human_label: "pass",
      human_severity: "standard",
    };
    const response = await callJudge(config, documents, testCase, { provider: "openai" });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toBe(JSON.stringify(buildJudgeRequest(config, documents, testCase)));
    expect(createHash("sha256").update(bodies[0]!, "utf8").digest("hex")).toBe(
      requestSha256(buildJudgeRequest(config, documents, testCase)),
    );
    expect(response).toStrictEqual({
      raw: "",
      resolved_model_id: "served-model",
      response_id: "chatcmpl-test",
      finish_reason: "stop",
      refusal: "I can't help with that.",
    });
  });
});
