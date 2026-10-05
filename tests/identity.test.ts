import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_DIGEST_PATHS, loadEvaluatorConfig } from "../src/config.ts";
import {
  canonicalJson,
  computeCorpusHash,
  computeEvaluatorId,
  sha256,
} from "../src/identity.ts";
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
   * `import type` targets that are not digested. The specifier scan below
   * cannot tell a type-only import from a runtime one, so a type-only import
   * of an undigested file would fail the closure check even though it is
   * erased before the code runs. Entries go here, each with a reason, rather
   * than in DIGEST_EXEMPT, so runtime exemptions stay a short audited list.
   * Empty today.
   */
  const TYPE_ONLY_EXEMPT: Record<string, string> = {};

  /**
   * Every relative specifier string literal in a source file ("./x", '../x',
   * `./x`), resolved to a repo path, whatever syntax surrounds it: static,
   * side-effect, re-export, dynamic, createRequire, several per line, after
   * a comment. Over-collecting (any such string counts, type-only imports
   * included) is the fail-closed direction.
   */
  function relativeSpecifiers(file: string, source: string): string[] {
    return [...source.matchAll(/(["'`])(\.{1,2}\/[^"'`\s]+)\1/g)].map((m) =>
      posix.join(posix.dirname(file), m[2]!),
    );
  }

  /** Module loads whose target a string scan cannot pin down. */
  function unresolvableLoads(source: string): string[] {
    const found: string[] = [];
    for (const m of source.matchAll(/\brequire\s*\(|\bcreateRequire\b/g)) {
      found.push(m[0]);
    }
    for (const m of source.matchAll(
      /\bimport\s*\((?!\s*(?:"[^"]*"|'[^']*'|`[^`$]*`)\s*\))/g,
    )) {
      found.push(m[0]);
    }
    return found;
  }

  it("catches relative specifiers whatever the surrounding syntax", () => {
    const source = [
      'import type { A } from "./types-only.ts";',
      'import {\n  c,\n  type D,\n} from "./multi-line.ts";',
      'import "./side.ts";',
      "const t = await import(`./template.ts`);",
      'const r = createRequire(import.meta.url)("./create-require.ts");',
      'import { a } from "./first.ts"; import { b } from "./same-line.ts";',
      '/* leading comment */ import { e } from "./after-comment.ts";',
      'export type T = string\nexport { f } from "./re-export.ts";',
      'import z from "zod";',
    ].join("\n");
    expect(relativeSpecifiers("src/x.ts", source).sort()).toEqual([
      "src/after-comment.ts",
      "src/create-require.ts",
      "src/first.ts",
      "src/multi-line.ts",
      "src/re-export.ts",
      "src/same-line.ts",
      "src/side.ts",
      "src/template.ts",
      "src/types-only.ts",
    ]);
    expect(unresolvableLoads(source)).toEqual(["createRequire"]);
  });

  it("flags require and non-literal dynamic import", () => {
    expect(unresolvableLoads('require("./a.ts")')).toEqual(["require("]);
    expect(unresolvableLoads("import(name)")).toEqual(["import("]);
    expect(unresolvableLoads("import(`./${name}.ts`)")).toEqual(["import("]);
    expect(unresolvableLoads('import("./a.ts"); import(`./b.ts`)')).toEqual([]);
    expect(unresolvableLoads("requireEnv(KEY)")).toEqual([]);
  });

  it("every relative specifier in a digested file is digested or allowlisted", () => {
    const seen = new Set<string>();
    for (const file of IMPLEMENTATION_DIGEST_PATHS.filter((p) => p.startsWith("src/"))) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(unresolvableLoads(source), `${file} loads a module the scan cannot resolve`).toEqual([]);
      for (const dep of relativeSpecifiers(file, source)) {
        seen.add(dep);
        expect(
          IMPLEMENTATION_DIGEST_PATHS.includes(dep) ||
            dep in DIGEST_EXEMPT ||
            dep in TYPE_ONLY_EXEMPT,
          `${file} references ${dep}, which is neither digested nor allowlisted`,
        ).toBe(true);
      }
    }
    // Guards against the scan silently finding nothing.
    expect([...seen]).toEqual(
      expect.arrayContaining(["src/types.ts", "src/identity.ts", "src/env-file.ts", "src/corpus-docs.ts"]),
    );
  });
});
