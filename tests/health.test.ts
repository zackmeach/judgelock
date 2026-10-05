import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent.ts";
import {
  loadAgentRuntimeConfig,
  loadCorpus,
  loadEvaluatorConfig,
  loadEvaluatorRuntimeConfig,
} from "../src/config.ts";
import {
  listCorpusDocFiles,
  readCorpusDocument,
  searchCorpusDocuments,
} from "../src/corpus-docs.ts";
import {
  computeEvaluatorId,
  normalizeBlob,
} from "../src/identity.ts";
import { ROOT } from "./root.ts";

describe("bootstrap health", () => {
  it("loads judge runtime config with a dated model snapshot", () => {
    const runtime = loadEvaluatorRuntimeConfig(ROOT);
    expect(runtime.provider).toBe("openai");
    expect(runtime.model_id).toMatch(/-(\d{4}-\d{2}-\d{2}|\d{8})$/);
    expect(runtime.decoding.max_tokens).toBe(4096);
    expect(runtime.decoding.reasoning_effort).toBe("medium");
    expect(runtime.decoding.temperature).toBeUndefined();
  });

  it("loads agent runtime config separately from the judge", () => {
    const runtime = loadAgentRuntimeConfig(ROOT);
    expect(runtime.provider).toBe("anthropic");
    expect(runtime.model_id).toBe("claude-haiku-4-5-20251001");
  });

  it("loads full evaluator identity components from disk", () => {
    const config = loadEvaluatorConfig(ROOT);
    expect(config.rubric.length).toBeGreaterThan(0);
    expect(config.judge_prompt_template).toContain("{{question}}");
    expect(config.output_schema).toBeTypeOf("object");
    expect(config.implementation_digest).toMatch(/^[a-f0-9]{64}$/);

    const id = computeEvaluatorId(config);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(computeEvaluatorId(config)).toBe(id);
  });

  it("loads the golden corpus without duplicate ids", () => {
    const cases = loadCorpus(join(ROOT, "corpus", "cases.jsonl"));
    expect(cases.length).toBeGreaterThan(0);
    const ids = new Set(cases.map((c) => c.id));
    expect(ids.size).toBe(cases.length);
  });

  it("has corpus markdown docs on disk", () => {
    const files = listCorpusDocFiles(ROOT);
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
    expect(readCorpusDocument(ROOT, files[0]!)).toContain("#");
  });

  it("can search the corpus for a known enrollment term", () => {
    const matches = searchCorpusDocuments(ROOT, "General Enrollment Period", 3);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]?.filename).toMatch(/\.md$/);
  });

  it("creates an agent session with tool-oriented instructions", () => {
    const session = createAgentSession(ROOT);
    expect(session.root).toBe(ROOT);
    expect(session.systemPrompt).toContain("Medicare");
    expect(session.systemPrompt).toContain("tools");
    expect(session.runtime.provider).toBe("anthropic");
  });

  it("normalizes blobs deterministically", () => {
    expect(normalizeBlob("a\r\nb\rc")).toBe("a\nb\nc");
    expect(normalizeBlob("\uFEFFhello")).toBe("hello");
  });
});
