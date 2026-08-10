import { describe, expect, it } from "vitest";
import { executeAgentTool } from "../src/agent-tools.ts";
import { ROOT } from "./root.ts";

describe("agent tools", () => {
  it("list_documents returns corpus markdown files", () => {
    const raw = executeAgentTool(ROOT, "list_documents", {});
    const parsed = JSON.parse(raw) as { documents: string[] };
    expect(parsed.documents.length).toBeGreaterThanOrEqual(8);
    expect(parsed.documents[0]).toMatch(/\.md$/);
  });

  it("read_document returns full file content", () => {
    const raw = executeAgentTool(ROOT, "read_document", {
      filename: "01-when-coverage-starts.md",
    });
    const parsed = JSON.parse(raw) as { filename: string; content: string };
    expect(parsed.filename).toBe("01-when-coverage-starts.md");
    expect(parsed.content).toContain("Medicare");
  });

  it("read_document rejects invalid filenames", () => {
    const raw = executeAgentTool(ROOT, "read_document", {
      filename: "../secret.txt",
    });
    const parsed = JSON.parse(raw) as { error: string };
    expect(parsed.error).toContain("invalid corpus filename");
  });

  it("search_documents finds enrollment period text", () => {
    const raw = executeAgentTool(ROOT, "search_documents", {
      query: "General Enrollment Period",
      limit: 2,
    });
    const parsed = JSON.parse(raw) as {
      query: string;
      matches: Array<{ filename: string; snippet: string }>;
    };
    expect(parsed.matches.length).toBeGreaterThan(0);
    expect(parsed.matches[0]?.snippet.toLowerCase()).toContain("general enrollment");
  });

  it("returns an error for unknown tools", () => {
    const raw = executeAgentTool(ROOT, "fly_to_moon", {});
    const parsed = JSON.parse(raw) as { error: string };
    expect(parsed.error).toContain("unknown tool");
  });
});
