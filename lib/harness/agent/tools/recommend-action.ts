/**
 * `recommend_action` (Plan 5 §6, D-G21) — the ONE tool with consequences, and it does not execute.
 *
 * This is where D-G1's second clause is enforced in code rather than asserted in a prompt:
 *
 *     The agent may decide what to LOOK AT. It may never decide what to CHANGE.
 *
 * The tool's whole body is five steps, and there is deliberately no sixth:
 *
 *   1. Build a `ProposedAction` — with every id and amount read FROM THE SOURCE ROWS, not from
 *      what the model typed.
 *   2. Role check: `investigator` may propose only its closed set (D-H15).
 *   3. `verifyAction()` — the same deterministic business rules the pipelines use (D-H9).
 *   4. `gateStepActions()` — the existing engine: ceilings → standing rules → human (D-A3).
 *   5. Report the queued state back to the agent.
 *
 * A `high` verdict from a verifier still forces human review regardless of org config (D-H10).
 * The agent is never consulted about that, so it cannot argue its way past it — and because it
 * has no execute path at all, an approved recommendation still waits for whatever executes it.
 * Approval here means "a human agreed", not "it happened".
 *
 * ## Why only one action type is offered
 *
 * `ROLE_SPECS.investigator.allowedActionTypes` contains both `approve_invoice_payment` and
 * `book_journal_entry`, because both are things an investigator may legitimately propose. Only
 * the first is OFFERED here, and the reason is concrete rather than cautious: `verifyJournalEntry`
 * requires a chart of accounts to validate account codes against, and refuses to pass an entry
 * without one — correctly, since unverifiable account codes are exactly what it exists to catch.
 * FinFlow has no chart of accounts yet. Listing `book_journal_entry` in this tool's enum would
 * therefore invite the agent to spend turns on something structurally guaranteed to be rejected.
 *
 * When a chart of accounts lands, adding it here is one enum entry and one payload builder — the
 * role already permits it and the verifier is already written and tested.
 */

import { appendEvent } from "@/lib/harness/events";
import { roleMayPropose, roleSpec } from "@/lib/harness/roles";
import { verifyAction, DEFAULT_VERIFICATION_POLICY } from "@/lib/harness/verifiers";
import { gateStepActions } from "@/lib/approvals/service";
import { matchAp } from "@/lib/agents/matching";
import { APPROVE_INVOICE_PAYMENT } from "@/lib/harness/action-types";
import {
  fail,
  formatCents,
  type AgentTool,
  type ToolContext,
  type ToolResultEnvelope,
} from "@/lib/harness/agent/tools/types";
import type { LedgerRow } from "@/lib/harness/agent/datasets";
import type { Invoice, ProposedAction, PurchaseOrder } from "@/lib/types";

/** What this tool offers. See the module note on why `book_journal_entry` is not here. */
const RECOMMENDABLE = [APPROVE_INVOICE_PAYMENT] as const;

export const recommendAction: AgentTool = {
  name: "recommend_action",
  description:
    "Recommend a consequential action for a HUMAN to review. This does NOT perform the action — " +
    "it queues a proposal in the approval panel, where a person decides. Use it when your " +
    "investigation has produced a concrete, defensible next step. Cite the invoice's source id; " +
    "the amounts and the matching purchase order are read from the data, not from your " +
    "arguments. Recommending something the data does not support wastes a reviewer's attention.",
  parameters: {
    type: "object",
    properties: {
      actionType: {
        type: "string",
        enum: [...RECOMMENDABLE],
        description: "approve_invoice_payment — release a payment against a matched invoice.",
      },
      sourceId: {
        type: "string",
        description:
          "Source id of the INVOICE row, exactly as a data tool returned it. Its amount and " +
          "vendor are read from that row.",
      },
      poSourceId: {
        type: "string",
        description:
          "Optional: source id of the purchase order to match against. Omit and the " +
          "deterministic AP matcher finds it.",
      },
      summary: { type: "string", description: "One line a reviewer will see in the panel." },
      rationale: {
        type: "string",
        description: "Why the data supports this. Shown to the reviewer alongside the summary.",
      },
    },
    required: ["actionType", "sourceId", "summary", "rationale"],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResultEnvelope> {
    const actionType = String(args.actionType ?? "");
    const sourceId = String(args.sourceId ?? "");
    const summary = String(args.summary ?? "").trim();
    const rationale = String(args.rationale ?? "").trim();

    /* ---- 0. Arguments, as correctable messages ---------------------------- */
    if (!(RECOMMENDABLE as readonly string[]).includes(actionType)) {
      const allowed = roleSpec("investigator").allowedActionTypes;
      return fail(
        `"${actionType}" is not an action you can recommend here.`,
        allowed.includes(actionType)
          ? `"${actionType}" cannot be verified in this deployment yet, so it cannot be queued. ` +
            `Recommendable now: ${RECOMMENDABLE.join(", ")}.`
          : `Recommendable: ${RECOMMENDABLE.join(", ")}.`,
      );
    }
    if (summary.length === 0 || rationale.length === 0) {
      return fail(
        "A recommendation needs both a summary and a rationale.",
        "A reviewer sees only these two fields — an empty one makes the proposal unreviewable.",
      );
    }

    const invoiceRow = ctx.rows.find((r) => r.sourceId === sourceId);
    if (!invoiceRow) {
      return fail(
        `sourceId "${sourceId}" does not exist.`,
        "Cite a source id exactly as a data tool returned it — a recommendation must be bound " +
          "to a real row.",
      );
    }
    if (invoiceRow.dataset !== "invoice") {
      return fail(
        `approve_invoice_payment must cite an invoice, but "${sourceId}" is a ` +
          `${invoiceRow.dataset} row.`,
        "Use get_transactions with datasets=[\"invoice\"] to find the invoice's source id.",
      );
    }

    /* ---- 1. Build the action from SOURCE DATA, not from the model --------- */
    // The correctness story turns on this: the model chooses WHICH rows, and code reads the
    // amounts off them. No number the model typed reaches the approval engine.
    const built = buildPaymentAction(invoiceRow, args.poSourceId, summary, ctx);
    if ("error" in built) return built.error;
    const action = built.action;

    /* ---- 2. Role constraint (D-H15) --------------------------------------- */
    if (!roleMayPropose("investigator", actionType)) {
      return fail(
        `The investigator role may not propose "${actionType}".`,
        `Allowed: ${roleSpec("investigator").allowedActionTypes.join(", ")}.`,
      );
    }

    /* ---- 3. Deterministic verification (D-H9) ----------------------------- */
    const verdict = verifyAction(action, {
      files: {},
      priorOutputs: {},
      policy: DEFAULT_VERIFICATION_POLICY,
    });

    if (!verdict.pass) {
      // Recorded as a rejection on the trail, then handed back as a correctable message. A
      // reviewer is never shown a machine-rejectable action — that is the whole point of
      // verifying before authorizing, and it is what stops reviewers rubber-stamping.
      await appendEvent(ctx.db, {
        workflowId: ctx.workflowId,
        eventType: "action_failed_verification",
        actor: "agent",
        turnNumber: ctx.turn,
        payload: {
          action_key: action.actionKey,
          action_type: actionType,
          failure: "business_rule",
          reason: verdict.reason,
          risk_level: verdict.riskLevel,
          source_id: sourceId,
        },
      });
      return fail(
        `Verification rejected this recommendation: ${verdict.reason}`,
        "Nothing was queued and no reviewer was asked. Address what the verifier named, or " +
          "report the issue in your answer instead of recommending an action.",
      );
    }

    /* ---- 4. Authorization (D-A3) ------------------------------------------ */
    let queued;
    try {
      queued = await gateStepActions(ctx.db, {
        workflowId: ctx.workflowId,
        orgId: ctx.orgId,
        stepKey: "investigate",
        stepId: null,
        actions: [action],
      });
    } catch (err) {
      return fail(
        `Could not queue the recommendation: ${err instanceof Error ? err.message : String(err)}`,
        "Continue the investigation and describe the recommendation in your answer instead.",
      );
    }

    const record = queued[0];
    const status = record?.status ?? "pending";
    ctx.recommendations.push({ action, status });

    const mandatory = verdict.riskLevel === "high";
    await appendEvent(ctx.db, {
      workflowId: ctx.workflowId,
      eventType: "action_proposed",
      actor: "agent",
      turnNumber: ctx.turn,
      payload: {
        action_type: actionType,
        action_key: action.actionKey,
        target: action.target,
        params: action.payload ?? null,
        risk_class: action.riskClass,
        reasoning: rationale,
        proposed_by_role: "investigator",
        verification_risk_level: verdict.riskLevel,
        queued_status: status,
        mandatory_human_review: mandatory,
      },
    });

    /* ---- 5. Report back. There is no step 6. ------------------------------ */
    return {
      ok: true,
      summary:
        `Queued for human review: ${summary} ` +
        `(${formatCents(action.target.amountCents ?? 0)}). Status: ${status}.`,
      data: {
        actionKey: action.actionKey,
        actionType,
        status,
        decisionSource: record?.decision_source ?? null,
        decisionReason: record?.decision_reason ?? null,
        riskClass: action.riskClass,
        verificationRiskLevel: verdict.riskLevel,
        mandatoryHumanReview: mandatory,
      },
      hint:
        "This is a PROPOSAL, not an executed action — a human decides in the approval panel. " +
        "In your final answer describe it as a recommendation, never as something that has " +
        "happened.",
    };
  },
};

/* -------------------------------------------------------------------------- */

/**
 * Build the payment action, resolving the purchase order deterministically.
 *
 * `verifyApMatch` compares the invoice against its PO, so both amounts have to be real. The
 * agent may name the PO, but even then the amount comes from the PO row — naming it is a
 * selection, not an assertion about its value.
 */
function buildPaymentAction(
  invoiceRow: LedgerRow,
  poSourceIdArg: unknown,
  summary: string,
  ctx: ToolContext,
): { action: ProposedAction } | { error: ToolResultEnvelope } {
  let poRow: LedgerRow | undefined;

  if (typeof poSourceIdArg === "string" && poSourceIdArg.length > 0) {
    poRow = ctx.rows.find((r) => r.sourceId === poSourceIdArg);
    if (!poRow) {
      return {
        error: fail(
          `poSourceId "${poSourceIdArg}" does not exist.`,
          "Omit poSourceId to let the deterministic matcher find the purchase order.",
        ),
      };
    }
    if (poRow.dataset !== "po") {
      return {
        error: fail(
          `poSourceId "${poSourceIdArg}" is a ${poRow.dataset} row, not a purchase order.`,
          'Use get_transactions with datasets=["po"] to find it.',
        ),
      };
    }
  } else {
    poRow = findMatchingPo(invoiceRow, ctx);
  }

  if (!poRow) {
    // Not an error the agent should route around: an invoice with no PO is precisely the case a
    // human must decide on any basis, and the verifier would say so anyway. Saying it here saves
    // a round trip and gives a more useful instruction.
    return {
      error: fail(
        `No purchase order matches invoice "${invoiceRow.reference ?? invoiceRow.sourceId}".`,
        "An invoice with no PO cannot be recommended for payment — there is nothing to check it " +
          "against. Report it as an exception in your answer instead, or name the PO explicitly " +
          "with poSourceId if you have found one the matcher missed.",
      ),
    };
  }

  return {
    action: {
      actionKey: `${APPROVE_INVOICE_PAYMENT}:${invoiceRow.sourceId}`,
      actionType: APPROVE_INVOICE_PAYMENT,
      riskClass: "moves_money",
      target: {
        kind: "invoice",
        id: invoiceRow.sourceId,
        counterparty: invoiceRow.counterparty,
        amountCents: invoiceRow.amountCents,
      },
      summary,
      payload: {
        // Exactly the shape `verifyApMatch` reads. Every value from a row.
        invoiceId: invoiceRow.sourceId,
        poId: poRow.sourceId,
        invoiceAmountCents: invoiceRow.amountCents,
        poAmountCents: poRow.amountCents,
        invoice_reference: invoiceRow.reference,
        po_reference: poRow.reference,
        vendor: invoiceRow.counterparty,
        recommended_by: "investigator",
      },
    },
  };
}

/** Run the tested AP matcher over the org's invoices and POs and pull out this invoice's match. */
function findMatchingPo(invoiceRow: LedgerRow, ctx: ToolContext): LedgerRow | undefined {
  const invoiceRows = ctx.rows.filter((r) => r.dataset === "invoice");
  const poRows = ctx.rows.filter((r) => r.dataset === "po");
  if (poRows.length === 0) return undefined;

  // The matcher works on the typed row shapes and on its own ids, so source ids are used AS the
  // ids — the mapping back is then the identity, which is one fewer place to get it wrong.
  const invoices: Invoice[] = invoiceRows.map((r) => ({
    id: r.sourceId,
    invoiceNumber: r.reference ?? "",
    vendorName: r.counterparty ?? "",
    lineItem: r.description,
    amountCents: r.amountCents,
    invoiceDate: r.date ?? "",
    dueDate: r.date ?? "",
  }));
  const pos: PurchaseOrder[] = poRows.map((r) => ({
    id: r.sourceId,
    poNumber: r.reference ?? "",
    vendorName: r.counterparty ?? "",
    lineItem: r.description,
    amountCents: r.amountCents,
    issuedDate: r.date ?? "",
    approvedBy: "",
  }));

  const pass = matchAp(invoices, pos);
  const exact = pass.matchedPairs.find((p) => p.invoiceId === invoiceRow.sourceId);
  if (exact) return poRows.find((r) => r.sourceId === exact.poId);

  // A candidate is a pair the deterministic pass flagged as plausible but not exact. Using one
  // is safe here because the VERIFIER still checks the amounts against the tolerance band — the
  // matcher only decides which PO to check against, never whether the payment is allowed.
  const candidate = pass.candidatePairs.find((p) => p.invoiceId === invoiceRow.sourceId);
  if (candidate) return poRows.find((r) => r.sourceId === candidate.poId);

  return undefined;
}
