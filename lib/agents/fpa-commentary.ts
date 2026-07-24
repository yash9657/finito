/**
 * Workflow 3 — FP&A Budget-vs-Actual Commentary steps (PLAN §9, §5.2).
 *
 * Fully sequential, all on the `main` track (no parallel parse tracks): a deterministic
 * parse-and-join, a deterministic variance computation, a deterministic ranking, then
 * two LLM steps (per-variance commentary and board-deck content). Step 6 (human
 * review) is a status gate — no step row (§9).
 *
 * Hybrid discipline (D3/D7): every join, variance, percentage, direction and ranking is
 * computed in code; Claude writes only language. The variance numbers Claude sees are
 * for context — they are NOT echoed back into the output; the output's numbers are the
 * code-computed ones, with Claude's commentary joined back by (department, category).
 */

import type {
  ActualsLine,
  BudgetLine,
  DagStepDefinition,
  FpaDepartmentSummary,
  FpaLine,
  FpaOutput,
  FpaVarianceComment,
  LlmFn,
  LlmInvokeResult,
  StepContext,
  StepResult,
  VarianceDirection,
} from "@/lib/types";
import { fpaBoardDeckSchema, fpaCommentarySchema } from "@/lib/types";
import type { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Step output shapes (persisted; consumed via ctx.priorOutputs).              */
/* -------------------------------------------------------------------------- */

interface JoinedLine {
  id: string;
  department: string;
  category: string;
  period: string;
  budgetedAmountCents: number;
  actualAmountCents: number;
  unjoined: boolean;
}

interface JoinStepOutput {
  lines: JoinedLine[];
  stats: {
    budgetLineCount: number;
    actualsLineCount: number;
    joinedCount: number;
    unjoinedCount: number;
  };
}

interface VarianceStepOutput {
  variances: FpaLine[];
}

interface RankStepOutput {
  variances: FpaLine[]; // all lines, material flagged
  materialVariances: FpaLine[]; // top 10 by |variance|
}

interface CommentaryStepOutput {
  varianceComments: FpaVarianceComment[];
  overallStatus: FpaOutput["overallStatus"];
  materialVariances: FpaLine[]; // commentary joined in
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function budgetFrom(ctx: StepContext): BudgetLine[] {
  return (ctx.files["budget"]?.rows ?? []) as unknown as BudgetLine[];
}

function actualsFrom(ctx: StepContext): ActualsLine[] {
  return (ctx.files["actuals"]?.rows ?? []) as unknown as ActualsLine[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function joinKey(dept: string, category: string, period: string): string {
  return `${norm(dept)}|${norm(category)}|${norm(period)}`;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Case-insensitive (dept, category) key for joining commentary back to lines. */
function dcKey(dept: string, category: string): string {
  return `${norm(dept)}|${norm(category)}`;
}

/**
 * Call Claude, then apply a code-side semantic validation. On the first failure the
 * validation error is appended to the user prompt and the call is retried once; a
 * second failure throws (D3 — one retry with the error appended, then step error).
 */
async function callWithValidation<T>(opts: {
  llm: LlmFn;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  validate: (data: T) => string | null;
}): Promise<LlmInvokeResult<T>> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? opts.user
        : `${opts.user}\n\nYour previous response had a problem: ${lastError}. Fix it and return corrected JSON.`;
    const res = await opts.llm({ system: opts.system, user, schema: opts.schema });
    const err = opts.validate(res.data);
    if (err === null) return res;
    lastError = err;
  }
  throw new Error(`Model output failed post-validation after retry: ${lastError}`);
}

/* -------------------------------------------------------------------------- */
/* Step 1 (main) — Parse & join (deterministic full outer join).               */
/* -------------------------------------------------------------------------- */

const parseAndJoin: DagStepDefinition = {
  key: "parse_join",
  stepNumber: 1,
  dependsOn: [],
  role: "parser",
  track: "main",
  name: "Parse & join budget and actuals",
  kind: "deterministic",
  async run(ctx: StepContext): Promise<StepResult> {
    const budget = budgetFrom(ctx);
    const actuals = actualsFrom(ctx);

    const budgetByKey = new Map<string, BudgetLine>();
    for (const b of budget) budgetByKey.set(joinKey(b.department, b.category, b.period), b);
    const actualsByKey = new Map<string, ActualsLine>();
    for (const a of actuals) actualsByKey.set(joinKey(a.department, a.category, a.period), a);

    const lines: JoinedLine[] = [];
    const seen = new Set<string>();
    let counter = 0;
    const nextId = () => `fpa-${String(++counter).padStart(3, "0")}`;

    // Budget side first (preserves budget display strings), then actuals-only lines.
    for (const b of budget) {
      const key = joinKey(b.department, b.category, b.period);
      if (seen.has(key)) continue;
      seen.add(key);
      const a = actualsByKey.get(key);
      lines.push({
        id: nextId(),
        department: b.department,
        category: b.category,
        period: b.period,
        budgetedAmountCents: b.budgetedAmountCents,
        actualAmountCents: a?.actualAmountCents ?? 0,
        unjoined: a === undefined,
      });
    }
    for (const a of actuals) {
      const key = joinKey(a.department, a.category, a.period);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({
        id: nextId(),
        department: a.department,
        category: a.category,
        period: a.period,
        budgetedAmountCents: 0,
        actualAmountCents: a.actualAmountCents,
        unjoined: true,
      });
    }

    const unjoinedCount = lines.filter((l) => l.unjoined).length;
    const output: JoinStepOutput = {
      lines,
      stats: {
        budgetLineCount: budget.length,
        actualsLineCount: actuals.length,
        joinedCount: lines.length - unjoinedCount,
        unjoinedCount,
      },
    };

    return {
      output,
      reasoning: `Full outer join on (department, category, period): ${budget.length} budget and ${actuals.length} actuals rows produced ${lines.length} joined lines. ${unjoinedCount} line(s) present on only one side (missing side treated as 0, marked unjoined).`,
      sources: [
        {
          file: ctx.files["budget"]?.meta.filename || "budget",
          note: `sha256 ${ctx.files["budget"]?.meta.sha256 ?? "n/a"}`,
        },
        {
          file: ctx.files["actuals"]?.meta.filename || "actuals",
          note: `sha256 ${ctx.files["actuals"]?.meta.sha256 ?? "n/a"}`,
        },
      ],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 2 (main) — Compute variances (deterministic).                          */
/* -------------------------------------------------------------------------- */

const computeVariances: DagStepDefinition = {
  key: "compute_variances",
  stepNumber: 2,
  dependsOn: ["parse_join"],
  role: "parser",
  track: "main",
  name: "Compute variances",
  kind: "deterministic",
  async run(ctx: StepContext): Promise<StepResult> {
    const join = ctx.priorOutputs["parse_join"] as JoinStepOutput;

    const variances: FpaLine[] = join.lines.map((l) => {
      const varianceCents = l.actualAmountCents - l.budgetedAmountCents;
      const variancePct =
        l.budgetedAmountCents === 0
          ? null
          : (varianceCents / l.budgetedAmountCents) * 100;
      let direction: VarianceDirection;
      if (variancePct === null || Math.abs(variancePct) <= 5) {
        direction = "on_track";
      } else {
        direction = varianceCents > 0 ? "over" : "under";
      }
      return {
        id: l.id,
        department: l.department,
        category: l.category,
        period: l.period,
        budgetedAmountCents: l.budgetedAmountCents,
        actualAmountCents: l.actualAmountCents,
        unjoined: l.unjoined,
        varianceCents,
        variancePct,
        direction,
        material: false,
      };
    });

    const overCount = variances.filter((v) => v.direction === "over").length;
    const underCount = variances.filter((v) => v.direction === "under").length;
    const output: VarianceStepOutput = { variances };

    return {
      output,
      reasoning: `Computed variance (actual − budget), variance % (null where budget is 0) and direction for ${variances.length} lines. ${overCount} over budget, ${underCount} under budget, ${variances.length - overCount - underCount} on track (|pct| ≤ 5% or undefined).`,
      sources: [{ file: "joined lines", note: `${variances.length} lines` }],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 3 (main) — Rank material variances (deterministic top-10).             */
/* -------------------------------------------------------------------------- */

const rankVariances: DagStepDefinition = {
  key: "rank_variances",
  stepNumber: 3,
  dependsOn: ["compute_variances"],
  role: "parser",
  track: "main",
  name: "Rank material variances",
  kind: "deterministic",
  async run(ctx: StepContext): Promise<StepResult> {
    const prior = ctx.priorOutputs["compute_variances"] as VarianceStepOutput;

    const ranked = [...prior.variances].sort(
      (a, b) =>
        Math.abs(b.varianceCents) - Math.abs(a.varianceCents) ||
        a.id.localeCompare(b.id),
    );
    const materialIds = new Set(ranked.slice(0, 10).map((v) => v.id));

    const variances: FpaLine[] = prior.variances.map((v) => ({
      ...v,
      material: materialIds.has(v.id),
    }));
    const materialVariances = ranked
      .slice(0, 10)
      .map((v) => ({ ...v, material: true }));

    const output: RankStepOutput = { variances, materialVariances };

    return {
      output,
      reasoning: `Ranked ${prior.variances.length} lines by absolute variance; the top ${materialVariances.length} are flagged material. Largest: ${
        materialVariances[0]
          ? `${materialVariances[0].department} / ${materialVariances[0].category} at $${dollars(materialVariances[0].varianceCents)}`
          : "none"
      }.`,
      sources: [{ file: "variance table", note: `${materialVariances.length} material lines` }],
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 4 (main) — Commentary (LLM per material variance).                      */
/* -------------------------------------------------------------------------- */

const FPA_COMMENTARY_SYSTEM = `You are a CFO-level financial analyst writing month-end budget-vs-actual commentary for a board report. You do not have access to underlying business context, so: state each variance factually with the amount and direction, offer the most plausible category-level explanation (e.g. headcount timing, vendor invoice timing, milestone payments), and explicitly flag that the specific driver needs management confirmation. Professional, concise, no filler. Write one commentary entry for every material variance you are given, using its exact department and category. Do not add commentary for lines that are not in the provided list.`;

const commentary: DagStepDefinition = {
  key: "commentary",
  stepNumber: 4,
  dependsOn: ["rank_variances"],
  role: "writer",
  track: "main",
  name: "Write variance commentary",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const ranked = ctx.priorOutputs["rank_variances"] as RankStepOutput;
    const material = ranked.materialVariances;

    const { data, reasoning, meta } = await callWithValidation({
      llm: ctx.llm,
      system: FPA_COMMENTARY_SYSTEM,
      user: JSON.stringify({
        materialVariances: material.map((m) => ({
          department: m.department,
          category: m.category,
          period: m.period,
          budget: dollars(m.budgetedAmountCents),
          actual: dollars(m.actualAmountCents),
          variance: dollars(m.varianceCents),
          variancePct: m.variancePct === null ? null : `${m.variancePct.toFixed(1)}%`,
          direction: m.direction,
        })),
      }),
      schema: fpaCommentarySchema,
      validate: (d) => {
        const got = new Set(d.varianceComments.map((c) => dcKey(c.department, c.category)));
        const missing = material.filter((m) => !got.has(dcKey(m.department, m.category)));
        if (missing.length > 0) {
          const list = missing.map((m) => `${m.department}/${m.category}`).join(", ");
          return `these material variances have no commentary: ${list}`;
        }
        return null;
      },
    });

    // Join Claude's commentary back to code-computed material lines by (dept, category).
    const commentByKey = new Map(
      data.varianceComments.map((c) => [dcKey(c.department, c.category), c.commentary]),
    );
    const varianceComments: FpaVarianceComment[] = material.map((m) => ({
      department: m.department,
      category: m.category,
      commentary: commentByKey.get(dcKey(m.department, m.category)) ?? "",
    }));
    const materialWithCommentary: FpaLine[] = material.map((m) => ({
      ...m,
      commentary: commentByKey.get(dcKey(m.department, m.category)) ?? "",
    }));

    const output: CommentaryStepOutput = {
      varianceComments,
      overallStatus: data.overallStatus,
      materialVariances: materialWithCommentary,
    };

    return {
      output,
      reasoning,
      sources: [{ file: "material variances", note: `${material.length} commentary entries` }],
      llmMeta: meta,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Step 5 (main) — Board deck content (LLM) + final assembled output.          */
/* -------------------------------------------------------------------------- */

const FPA_DECK_SYSTEM = `You are a CFO-level financial analyst assembling the FP&A section of a board deck. Given the overall budget-vs-actual status and per-department variance summaries, write: (1) a 3-4 sentence executive summary of the month's budget performance, and (2) one concise one-line summary per department capturing its budget-vs-actual position. Professional and board-appropriate, no filler. Provide a summary for every department in the provided list, using its exact name, and do not invent departments.`;

const boardDeck: DagStepDefinition = {
  key: "board_deck",
  stepNumber: 5,
  dependsOn: ["rank_variances", "commentary"],
  role: "writer",
  track: "main",
  name: "Board deck content",
  kind: "llm",
  async run(ctx: StepContext): Promise<StepResult> {
    const ranked = ctx.priorOutputs["rank_variances"] as RankStepOutput;
    const commentaryOut = ctx.priorOutputs["commentary"] as CommentaryStepOutput;

    // Department-level roll-up (code-computed) for the deck prompt.
    const deptAgg = new Map<
      string,
      { department: string; budget: number; actual: number; variance: number }
    >();
    for (const v of ranked.variances) {
      const key = norm(v.department);
      const agg = deptAgg.get(key) ?? {
        department: v.department,
        budget: 0,
        actual: 0,
        variance: 0,
      };
      agg.budget += v.budgetedAmountCents;
      agg.actual += v.actualAmountCents;
      agg.variance += v.varianceCents;
      deptAgg.set(key, agg);
    }
    const departments = [...deptAgg.values()];
    const wantDepts = new Set(departments.map((d) => norm(d.department)));

    const { data, reasoning, meta } = await callWithValidation({
      llm: ctx.llm,
      system: FPA_DECK_SYSTEM,
      user: JSON.stringify({
        overallStatus: commentaryOut.overallStatus,
        materialVariances: commentaryOut.varianceComments,
        departments: departments.map((d) => ({
          department: d.department,
          budget: dollars(d.budget),
          actual: dollars(d.actual),
          variance: dollars(d.variance),
        })),
      }),
      schema: fpaBoardDeckSchema,
      validate: (d) => {
        const got = new Set(d.departmentSummaries.map((s) => norm(s.department)));
        const missing = departments.filter((dp) => !got.has(norm(dp.department)));
        if (missing.length > 0) {
          const list = missing.map((m) => m.department).join(", ");
          return `these departments have no summary: ${list}`;
        }
        return null;
      },
    });

    // Join department summaries back to code department list (dedupe, keep coverage).
    const summaryByDept = new Map(
      data.departmentSummaries.map((s) => [norm(s.department), s.summary]),
    );
    const departmentSummaries: FpaDepartmentSummary[] = departments.map((d) => ({
      department: d.department,
      summary: summaryByDept.get(norm(d.department)) ?? "",
    }));

    // Final output — all numbers code-computed; commentary joined onto material lines.
    const commentByKey = new Map(
      commentaryOut.varianceComments.map((c) => [dcKey(c.department, c.category), c.commentary]),
    );
    const variances: FpaLine[] = ranked.variances.map((v) =>
      v.material
        ? { ...v, commentary: commentByKey.get(dcKey(v.department, v.category)) ?? "" }
        : v,
    );

    const output: FpaOutput = {
      variances,
      materialVariances: commentaryOut.materialVariances,
      varianceComments: commentaryOut.varianceComments,
      overallStatus: commentaryOut.overallStatus,
      executiveSummary: data.executiveSummary,
      departmentSummaries,
      cashRunway: null,
    };

    return {
      output,
      reasoning,
      sources: [{ file: "board deck", note: `${departmentSummaries.length} department summaries` }],
      llmMeta: meta,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Exported step list. Step 6 (human review) is a status gate — no row (§9).   */
/* -------------------------------------------------------------------------- */

export const fpaCommentarySteps: DagStepDefinition[] = [
  parseAndJoin,
  computeVariances,
  rankVariances,
  commentary,
  boardDeck,
];
