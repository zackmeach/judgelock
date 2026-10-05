import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEvaluatorConfig } from "../src/config.ts";
import { computeCorpusHash, computeEvaluatorId } from "../src/identity.ts";
import type { GoldenCase, ReferenceDocument } from "../src/types.ts";
import { ROOT } from "./root.ts";

const CASES: GoldenCase[] = [
  { id: "a", question: "q1", answer: "a1", human_label: "pass", human_severity: "standard" },
  { id: "b", question: "q2", answer: "a2", human_label: "incorrect", human_severity: "critical" },
];
const DOCS: ReferenceDocument[] = [
  { filename: "a.md", content: "# A\nline one\n" },
  { filename: "b.md", content: "# B\nPart B is $202.90.\n" },
];

describe("computeCorpusHash", () => {
  const base = computeCorpusHash(CASES, DOCS);

  it("changes when one document's content changes", () => {
    const edited = [DOCS[0]!, { filename: "b.md", content: "# B\nPart B is $185.00.\n" }];
    expect(computeCorpusHash(CASES, edited)).not.toBe(base);
  });

  it("changes when a document is added", () => {
    const added = [...DOCS, { filename: "c.md", content: "# C\n" }];
    expect(computeCorpusHash(CASES, added)).not.toBe(base);
  });

  it("is unchanged when documents or cases are reordered", () => {
    expect(computeCorpusHash([...CASES].reverse(), [...DOCS].reverse())).toBe(base);
  });

  it("is unchanged when document content has CRLF instead of LF", () => {
    const crlf = DOCS.map((d) => ({ ...d, content: d.content.replace(/\n/g, "\r\n") }));
    expect(computeCorpusHash(CASES, crlf)).toBe(base);
  });
});

describe("implementation digest scope", () => {
  it("ignores agent code and tracks scoring code", () => {
    const tmp = mkdtempSync(join(tmpdir(), "judgelock-digest-"));
    try {
      for (const p of ["rubric", "prompts", "schemas", "evaluator.config.json", "package-lock.json", "src"]) {
        cpSync(join(ROOT, p), join(tmp, p), { recursive: true });
      }
      const before = computeEvaluatorId(loadEvaluatorConfig(tmp));
      expect(before).toBe(computeEvaluatorId(loadEvaluatorConfig(ROOT)));

      appendFileSync(join(tmp, "src", "agent.ts"), "\n// digest scope probe\n");
      expect(computeEvaluatorId(loadEvaluatorConfig(tmp))).toBe(before);

      appendFileSync(join(tmp, "src", "judge.ts"), "\n// digest scope probe\n");
      expect(computeEvaluatorId(loadEvaluatorConfig(tmp))).not.toBe(before);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
