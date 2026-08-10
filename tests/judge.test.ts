import { describe, expect, it } from "vitest";
import { parseVerdict } from "../src/judge.ts";

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
