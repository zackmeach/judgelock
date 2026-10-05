import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_DIGEST_PATHS, loadEvaluatorConfig } from "../src/config.ts";
import {
  canonicalJson,
  combineComponentHashes,
  componentHashes,
  computeCorpusHash,
  computeEvaluatorId,
  sha256,
} from "../src/identity.ts";
import type { EvaluatorConfig, GoldenCase, ReferenceDocument } from "../src/types.ts";
import { ROOT } from "./root.ts";

const CASES: GoldenCase[] = [
  { id: "a", question: "q1", answer: "a1", human_label: "pass", human_severity: "standard" },
  { id: "b", question: "q2", answer: "a2", human_label: "incorrect", human_severity: "critical" },
];
const DOCS: ReferenceDocument[] = [
  { filename: "a.md", content: "# A\nline one\n" },
  { filename: "b.md", content: "# B\nPart B is $202.90.\n" },
];

const mkCase = (id: string): GoldenCase => ({
  id,
  question: "q",
  answer: "a",
  human_label: "pass",
  human_severity: "standard",
});

/** Copies everything loadEvaluatorConfig reads into a fresh temp dir. */
function copyInputs(): string {
  const tmp = mkdtempSync(join(tmpdir(), "judgelock-digest-"));
  for (const p of ["rubric", "prompts", "schemas", "evaluator.config.json", "package-lock.json", "src"]) {
    cpSync(join(ROOT, p), join(tmp, p), { recursive: true });
  }
  return tmp;
}

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

  it("orders cases by code unit, not locale collation", () => {
    const ids = ["a-1", "A2", "a1", "b"];
    const codeUnitOrder = ["A2", "a-1", "a1", "b"];
    // Precondition: collation disagrees with code-unit order for these ids.
    expect([...ids].sort((a, b) => a.localeCompare(b, "en-US"))).not.toEqual(codeUnitOrder);

    const expected = sha256(
      canonicalJson({ cases: codeUnitOrder.map(mkCase), documents: DOCS }),
    );
    expect(computeCorpusHash(ids.map(mkCase), [...DOCS].reverse())).toBe(expected);
  });

  it("is reorder-invariant for canonically equivalent (NFC vs NFD) ids", () => {
    const nfc = mkCase("é");
    const nfd = mkCase("é");
    expect(computeCorpusHash([nfc, nfd], DOCS)).toBe(computeCorpusHash([nfd, nfc], DOCS));
  });
});

describe("computeEvaluatorId", () => {
  it("is byte-identical to the pre-split algorithm", () => {
    // The computeEvaluatorId body before combineComponentHashes was split out.
    const legacy = (hashes: Record<keyof EvaluatorConfig, string>): string =>
      sha256(
        (["rubric", "judge_prompt_template", "model_id", "decoding", "output_schema", "implementation_digest"] as const)
          .map((key) => `${key}:${hashes[key]}`)
          .join("\n"),
      );
    const real = loadEvaluatorConfig(ROOT);
    expect(computeEvaluatorId(real)).toBe(legacy(componentHashes(real)));
    expect(combineComponentHashes(componentHashes(real))).toBe(computeEvaluatorId(real));

    // Frozen: the pre-split code's output on this config, computed at 901492a.
    const synthetic: EvaluatorConfig = {
      rubric: "rubric v1\n",
      judge_prompt_template: "R:{{rubric}} D:{{documents}} Q:{{question}} A:{{answer}}",
      model_id: "gpt-5.4-2026-03-05",
      decoding: { max_tokens: 4096, reasoning_effort: "medium", stop_sequences: [] },
      output_schema: { type: "object" },
      implementation_digest: "0123abcd",
    };
    expect(computeEvaluatorId(synthetic)).toBe(
      "3c77a1a0560aef4e07122ae1225df07cf14d231c806a45aa291f8762429e5dc7",
    );
  });
});

describe("loadEvaluatorConfig", () => {
  it("normalizes rubric and template at load without moving the id", () => {
    const tmp = copyInputs();
    try {
      for (const rel of ["rubric/rubric.yaml", "prompts/judge.txt"]) {
        const lf = readFileSync(join(ROOT, rel), "utf8");
        writeFileSync(join(tmp, rel), `﻿${lf.replace(/\n/g, "\r\n")}`);
      }
      const lfConfig = loadEvaluatorConfig(ROOT);
      const crlfConfig = loadEvaluatorConfig(tmp);
      expect(crlfConfig.rubric).toBe(lfConfig.rubric);
      expect(crlfConfig.judge_prompt_template).toBe(lfConfig.judge_prompt_template);
      expect(computeEvaluatorId(crlfConfig)).toBe(computeEvaluatorId(lfConfig));

      // hashBlob is idempotent: raw and normalized bytes give the same id.
      const raw = { ...lfConfig, rubric: `﻿${lfConfig.rubric.replace(/\n/g, "\r\n")}` };
      expect(computeEvaluatorId(raw)).toBe(computeEvaluatorId(lfConfig));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("implementation digest scope", () => {
  it("ignores agent code and tracks scoring code", () => {
    const tmp = copyInputs();
    try {
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

  /** Runtime imports of digested files that are deliberately not digested. */
  const DIGEST_EXEMPT: Record<string, string> = {
    "src/env-file.ts":
      "API-key lookup only; never touches judge input or verdict parsing",
    "src/corpus-docs.ts":
      "selects files and loads content; both captured by corpus_hash, and renderDocuments canonicalizes order and line endings",
  };

  /**
   * Relative runtime imports of one source file, resolved to repo paths.
   * `import type` / `export type` are erased at runtime and skipped. `[^;]*?`
   * keeps a match inside one statement, so multi-line specifier lists work.
   */
  function runtimeRelativeImports(file: string, source: string): string[] {
    const specs: string[] = [];
    for (const m of source.matchAll(
      /^\s*(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/gm,
    )) {
      if (!m[1]) specs.push(m[2]!);
    }
    for (const m of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
      specs.push(m[1]!);
    }
    for (const m of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
      specs.push(m[1]!);
    }
    return specs
      .filter((s) => s.startsWith("."))
      .map((s) => posix.join(posix.dirname(file), s));
  }

  it("extracts runtime imports and skips type-only ones", () => {
    const source = [
      'import type { A } from "./agent.ts";',
      'import type {\n  B,\n} from "./cli.ts";',
      'import {\n  c,\n  type D,\n} from "./c.ts";',
      'import "./side.ts";',
      'export { e } from "./e.ts";',
      'import z from "zod";',
    ].join("\n");
    expect(runtimeRelativeImports("src/x.ts", source).sort()).toEqual(
      ["src/c.ts", "src/e.ts", "src/side.ts"],
    );
  });

  it("every runtime import of a digested file is digested or allowlisted", () => {
    const seen = new Set<string>();
    for (const file of IMPLEMENTATION_DIGEST_PATHS.filter((p) => p.startsWith("src/"))) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const dep of runtimeRelativeImports(file, source)) {
        seen.add(dep);
        expect(
          IMPLEMENTATION_DIGEST_PATHS.includes(dep) || dep in DIGEST_EXEMPT,
          `${file} imports ${dep}, which is neither digested nor allowlisted`,
        ).toBe(true);
      }
    }
    // Guards against the extractor silently finding nothing.
    expect([...seen]).toEqual(
      expect.arrayContaining(["src/types.ts", "src/identity.ts", "src/env-file.ts", "src/corpus-docs.ts"]),
    );
  });
});
