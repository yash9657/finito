/**
 * Answer validation tests (Plan 5, D-G14).
 *
 * This is where "every number is recomputed in code" stops being a claim. The tests that matter
 * most are the rejections: a fabricated citation, and a currency amount the model wrote itself.
 */

import { describe, expect, it } from "vitest";
import { validateAnswer, correctionMessage, type RawAnswer } from "@/lib/harness/agent/answer";
import { loadFixtureDatasets } from "@/lib/harness/agent/fixtures";

const datasets = loadFixtureDatasets(["erp_export"]);
const rows = datasets.rows;
const a = rows[0];
const b = rows[1];

function answer(overrides: Partial<RawAnswer> = {}): RawAnswer {
  return {
    prose: "Two entries did not clear, totalling {{gap}}.",
    findings: [{ statement: "Two entries did not clear", sourceIds: [a.sourceId, b.sourceId] }],
    figures: [
      { ref: "gap", label: "Uncleared total", operation: "sum", sourceIds: [a.sourceId, b.sourceId] },
    ],
    citations: [{ sourceId: a.sourceId, note: "First uncleared entry" }],
    ...overrides,
  };
}

describe("figures are computed from cited rows, not taken from the model", () => {
  it("sums the cited rows and substitutes the result into the prose", () => {
    const result = validateAnswer(answer(), rows, { partial: false });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const expected = a.amountCents + b.amountCents;
    expect(result.answer.figures[0].valueCents).toBe(expected);
    // The placeholder is gone and the computed figure is in the prose.
    expect(result.answer.prose).not.toContain("{{gap}}");
    expect(result.answer.prose).toContain((expected / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }));
    // Both forms are kept so the trail can show what the model wrote and what code computed.
    expect(result.answer.proseTemplate).toContain("{{gap}}");
  });

  it("counts rows for a count figure, unitless", () => {
    const result = validateAnswer(
      answer({
        prose: "There are {{n}} uncleared entries.",
        figures: [
          { ref: "n", label: "Count", operation: "count", sourceIds: [a.sourceId, b.sourceId] },
        ],
      }),
      rows,
      { partial: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.answer.figures[0].value).toBe(2);
    expect(result.answer.prose).toBe("There are 2 uncleared entries.");
  });

  it("rounds an average to integer cents rather than carrying a float", () => {
    const result = validateAnswer(
      answer({
        prose: "The mean is {{avg}}.",
        figures: [
          { ref: "avg", label: "Mean", operation: "average", sourceIds: [a.sourceId, b.sourceId] },
        ],
      }),
      rows,
      { partial: false },
    );
    if (!result.ok) throw new Error("unreachable");
    const value = result.answer.figures[0].valueCents!;
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBe(Math.round((a.amountCents + b.amountCents) / 2));
  });

  it("orders a difference by date when the rows are dated", () => {
    // Two rows with DISTINCT dates. With tied dates the sort is a no-op and the difference
    // follows citation order instead — which is the right fallback (the model expressed the
    // direction by which row it cited first) but would make this test assert nothing.
    const byDate = [...rows].filter((r) => r.date).sort((x, y) => (x.date ?? "").localeCompare(y.date ?? ""));
    const earlier = byDate[0];
    const later = byDate.find((r) => r.date !== earlier.date)!;
    const result = validateAnswer(
      answer({
        prose: "It moved by {{delta}}.",
        figures: [
          {
            ref: "delta",
            label: "Change",
            operation: "difference",
            // Deliberately cited in the WRONG order — code sorts by date, so the answer does not
            // depend on the model getting the order right.
            sourceIds: [later.sourceId, earlier.sourceId],
          },
        ],
      }),
      rows,
      { partial: false },
    );
    if (!result.ok) throw new Error("unreachable");
    expect(result.answer.figures[0].valueCents).toBe(later.amountCents - earlier.amountCents);
  });
});

describe("rejections", () => {
  it("rejects a fabricated source id, naming it", () => {
    const result = validateAnswer(
      answer({ citations: [{ sourceId: "wf:deadbeef/erp_export/erp-999", note: "invented" }] }),
      rows,
      { partial: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems[0]).toContain("wf:deadbeef/erp_export/erp-999");
  });

  it("REJECTS a currency amount the model wrote directly", () => {
    // The load-bearing test. Without this rule, citation checking is theatre: the model could
    // write "$42,000.00" and nothing would notice it was never computed.
    const result = validateAnswer(
      answer({ prose: "Two entries did not clear, totalling $42,000.00." }),
      rows,
      { partial: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems.join(" ")).toContain("$42,000.00");
    expect(result.problems.join(" ")).toContain("placeholder");
  });

  it("catches the other spellings of a written amount", () => {
    for (const prose of ["It is 4200 dollars.", "It is USD 4200.", "It is 4,200.00 USD."]) {
      const result = validateAnswer(answer({ prose }), rows, { partial: false });
      expect(result.ok, prose).toBe(false);
    }
  });

  it("allows bare numbers that are not money", () => {
    // "3 transactions" and "2026" are legitimate prose; rejecting them would make the rule
    // unusable and push the model toward spelling amounts out in words to evade it.
    const result = validateAnswer(
      answer({
        prose: "Across 2 entries in 2026, the gap is {{gap}}.",
      }),
      rows,
      { partial: false },
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a placeholder with no matching figure", () => {
    const result = validateAnswer(answer({ prose: "The gap is {{mystery}}." }), rows, {
      partial: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems[0]).toContain("mystery");
  });

  it("rejects a figure that cites no rows", () => {
    const result = validateAnswer(
      answer({ figures: [{ ref: "gap", label: "Gap", operation: "sum", sourceIds: [] }] }),
      rows,
      { partial: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems[0]).toContain("cites no source rows");
  });

  it("reports every problem at once, not one per turn", () => {
    // The corrective retry budget is one; drip-feeding errors would waste it.
    const result = validateAnswer(
      answer({
        prose: "It is $100.00 and {{unknown}}.",
        citations: [{ sourceId: "wf:deadbeef/erp_export/erp-999", note: "invented" }],
      }),
      rows,
      { partial: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe("correctionMessage", () => {
  it("restates the rule alongside the specific problems", () => {
    const message = correctionMessage(["source id X does not exist"]);
    expect(message).toContain("source id X does not exist");
    expect(message).toContain("{{ref}}");
  });
});

describe("partial answers", () => {
  it("carries the partial flag through", () => {
    const result = validateAnswer(answer(), rows, { partial: true });
    if (!result.ok) throw new Error("unreachable");
    expect(result.answer.partial).toBe(true);
  });
});
