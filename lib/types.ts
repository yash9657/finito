/**
 * Shared domain contract for FinFlow (PLAN §4, §5, §7, §8, §9).
 *
 * This is the single source of truth for:
 *   - parsed row shapes (money is integer cents everywhere past the parser — D7),
 *   - the status/track/enum vocabularies (D9),
 *   - the DB row interfaces that mirror the §4 tables (snake_case as stored),
 *   - the step-engine contract (StepContext / StepDefinition, §5.2),
 *   - every Claude structured-output Zod schema (§7/§8/§9) — kept PLAIN
 *     (objects/arrays/strings/enums only, no min/max/length, no recursion — §5.3/§15),
 *   - the computed output objects (recon summary, AP queue, FP&A output).
 *
 * Import from '@/lib/types' using these exact exported names; do not redefine locally.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

/* -------------------------------------------------------------------------- */
/* Enum vocabularies — string unions AND matching zod enums (single source).  */
/* -------------------------------------------------------------------------- */

export const WORKFLOW_TYPES = [
  "reconciliation",
  "ap_matching",
  "fpa_commentary",
] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export const workflowTypeEnum = z.enum(WORKFLOW_TYPES);

export const WORKFLOW_STATUSES = [
  "idle",
  "running",
  "awaiting_review",
  "approved",
  "rejected",
  "error",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const workflowStatusEnum = z.enum(WORKFLOW_STATUSES);

export const STEP_STATUSES = ["pending", "running", "complete", "error"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];
export const stepStatusEnum = z.enum(STEP_STATUSES);

export const TRACKS = ["A", "B", "C", "main"] as const;
export type Track = (typeof TRACKS)[number];
export const trackEnum = z.enum(TRACKS);

export const STEP_KINDS = ["deterministic", "llm"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const stepKindEnum = z.enum(STEP_KINDS);

export const FILE_TYPES = [
  "bank_statement",
  "erp_export",
  "invoice",
  "po",
  "budget",
  "actuals",
] as const;
export type FileType = (typeof FILE_TYPES)[number];
export const fileTypeEnum = z.enum(FILE_TYPES);

export const ACTOR_TYPES = ["agent", "human", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];
export const actorTypeEnum = z.enum(ACTOR_TYPES);

export const PROFILE_ROLES = ["admin", "analyst", "reviewer"] as const;
export type ProfileRole = (typeof PROFILE_ROLES)[number];
export const profileRoleEnum = z.enum(PROFILE_ROLES);

/**
 * The human review-gate decision vocabulary (review_decisions.decision, §4).
 * This union covers both the "decision" and "review decision" enums.
 */
export const REVIEW_DECISIONS = [
  "approved",
  "rejected",
  "revision_requested",
] as const;
export type ReviewDecisionValue = (typeof REVIEW_DECISIONS)[number];
export const reviewDecisionEnum = z.enum(REVIEW_DECISIONS);

/* -------------------------------------------------------------------------- */
/* Parsed row types (§5.1 / §8 / §9). Money fields are integer cents (D7);    */
/* row IDs are stable synthetic ids assigned in file order (D8).              */
/* -------------------------------------------------------------------------- */

/** Reconciliation — ERP export row (`erp-001…`). */
export interface ErpTxn {
  id: string;
  date: string; // ISO YYYY-MM-DD
  description: string;
  amountCents: number;
  referenceNumber: string;
}

/** Reconciliation — bank statement row (`bank-001…`). */
export interface BankTxn {
  id: string;
  date: string; // ISO YYYY-MM-DD
  description: string;
  amountCents: number;
  transactionId: string;
}

/** AP — invoice row (`inv-001…`). */
export interface Invoice {
  id: string;
  invoiceNumber: string;
  vendorName: string;
  lineItem: string;
  amountCents: number;
  invoiceDate: string; // ISO YYYY-MM-DD
  dueDate: string; // ISO YYYY-MM-DD
}

/** AP — purchase order row (`po-001…`). */
export interface PurchaseOrder {
  id: string;
  poNumber: string;
  vendorName: string;
  lineItem: string;
  amountCents: number;
  issuedDate: string; // ISO YYYY-MM-DD
  approvedBy: string;
}

/** FP&A — budget row. */
export interface BudgetLine {
  id: string;
  department: string;
  category: string;
  budgetedAmountCents: number;
  period: string; // YYYY-MM
}

/** FP&A — actuals row. */
export interface ActualsLine {
  id: string;
  department: string;
  category: string;
  actualAmountCents: number;
  period: string; // YYYY-MM
}

export const VARIANCE_DIRECTIONS = ["over", "under", "on_track"] as const;
export type VarianceDirection = (typeof VARIANCE_DIRECTIONS)[number];

/**
 * FP&A joined + computed line (§9 steps 1–3). Produced by the full outer join on
 * (department, category, period); missing side treated as 0 and marked `unjoined`.
 * Variance fields are filled by step 2; `material` is set by the ranking step;
 * `commentary` is joined back from Claude's output (§9 step 4).
 */
export interface FpaLine {
  id: string;
  department: string;
  category: string;
  period: string; // YYYY-MM
  budgetedAmountCents: number;
  actualAmountCents: number;
  unjoined: boolean;
  varianceCents: number; // actual − budget
  variancePct: number | null; // null when budget === 0
  direction: VarianceDirection;
  material: boolean;
  commentary?: string;
}

/* -------------------------------------------------------------------------- */
/* CSV/Excel parser output (§6). `{ rows, errors, meta }`.                     */
/* -------------------------------------------------------------------------- */

export type ParsedRow = Record<string, unknown>;

/** One skipped/invalid input row (finance files are dirty; the step still succeeds). */
export interface ParseError {
  /** 1-based row index in the source file. */
  row: number;
  message: string;
  raw?: unknown;
}

export interface ParsedFileMeta {
  filename: string;
  fileType: FileType;
  sha256: string;
  rowCount: number;
  skippedCount: number;
}

export interface ParsedFile<TRow extends ParsedRow = ParsedRow> {
  rows: TRow[];
  errors: ParseError[];
  meta: ParsedFileMeta;
}

/* -------------------------------------------------------------------------- */
/* Step engine contract (§5.2).                                               */
/* -------------------------------------------------------------------------- */

export interface StepSource {
  file: string;
  note: string;
}

/**
 * Provider-agnostic usage metadata for one `ctx.llm` call (Plan 2 §2.3, D-P11/D-P14).
 * `raw` is already redacted+capped by the router. Declared here (not in router.ts) so
 * types.ts stays the leaf module and the step contract has no import cycle.
 */
export interface LlmInvokeMeta {
  providerId: ProviderIdValue;
  modelUsed: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  raw: unknown;
}

export interface LlmInvokeResult<T> {
  data: T;
  reasoning: string; // reasoningNative || data.reasoning fallback
  meta: LlmInvokeMeta;
}

/**
 * The LLM closure the orchestrator builds per step (Plan 2 §4.1, D-P1). Step code calls
 * `ctx.llm(...)` and never sees provider keys or the router — the orchestrator has
 * already resolved the provider for this step's key (D-P7).
 */
export type LlmFn = <T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
}) => Promise<LlmInvokeResult<T>>;

export interface StepContext {
  workflowId: string;
  db: SupabaseClient; // admin client
  files: Record<string, ParsedFile>; // keyed by file_type
  priorOutputs: Record<string, unknown>; // step_key -> validated output (D-P5)
  /** Resolve + call the org's provider for this step (D-P1). LLM steps only. */
  llm: LlmFn;
}

export interface StepResult {
  output: unknown; // stored in workflow_steps.output
  reasoning: string; // the model's reasoning, or a generated summary
  sources: StepSource[];
  /**
   * The `meta` from the step's (final) `ctx.llm()` call, so the orchestrator can persist
   * provider/model/tokens/latency/raw (Plan 2 §4.1). Steps making zero LLM calls (or the
   * skip-adjudication path) leave this undefined.
   */
  llmMeta?: LlmInvokeMeta;
}

/** One node of a workflow graph (Plan 2 §4.1, D-P5/D-P8). */
export interface DagStepDefinition {
  key: string; // 'parse_erp' — unique within the workflow
  stepNumber: number; // stable UI order + DB unique constraint (D-P5)
  dependsOn: string[]; // keys; [] = source node
  role: StepRole; // D-P8
  track: Track; // UI layout hint only
  name: string; // display name (unchanged strings from PLAN.md)
  kind: StepKind;
  run(ctx: StepContext): Promise<StepResult>;
}

export interface WorkflowDefinition {
  type: WorkflowType;
  steps: DagStepDefinition[]; // validated at module load: no unknown/cyclic deps
}

/* -------------------------------------------------------------------------- */
/* DB row interfaces — mirror §4 tables, snake_case as stored.                */
/* -------------------------------------------------------------------------- */

export interface Organization {
  id: string;
  name: string;
  created_at: string;
}

export interface Profile {
  id: string;
  email: string;
  org_id: string;
  role: ProfileRole;
  created_at: string;
}

export interface Workflow {
  id: string;
  org_id: string;
  created_by: string | null;
  name: string;
  type: WorkflowType;
  status: WorkflowStatus;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowStep {
  id: string;
  workflow_id: string;
  step_number: number;
  step_key: string | null; // Plan 2, D-P5 (null on legacy rows until backfilled)
  track: Track;
  name: string;
  status: StepStatus;
  input_snapshot: unknown | null;
  output: unknown | null;
  agent_reasoning: string | null;
  sources: StepSource[] | null;
  model: string | null; // exact model string returned by the provider (D-P14)
  provider_used: string | null; // provider id (D-P14)
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  llm_raw: unknown | null; // redacted+capped provider response (D-P11); never sent to client
  input_hash: string | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowFile {
  id: string;
  workflow_id: string;
  file_type: FileType;
  storage_path: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  uploaded_at: string;
}

export interface AuditLogRow {
  id: number; // bigint identity
  workflow_id: string;
  step_id: string | null;
  actor_type: ActorType;
  actor_id: string; // model id, profile uuid, or 'system'
  action: string;
  detail: unknown | null;
  created_at: string; // D10 — named created_at, not timestamp
}

/* -------------------------------------------------------------------------- */
/* Plan 2 — LLM provider config rows (§3). snake_case as stored.               */
/* -------------------------------------------------------------------------- */

export const PROVIDER_IDS = [
  "anthropic",
  "openai",
  "google",
  "ollama",
  "custom",
] as const;
export type ProviderIdValue = (typeof PROVIDER_IDS)[number];
export const providerIdEnum = z.enum(PROVIDER_IDS);

/** Role each step declares (D-P8). Informational grouping; resolution is by step_key. */
export const STEP_ROLES = ["parser", "matcher", "classifier", "writer"] as const;
export type StepRole = (typeof STEP_ROLES)[number];

/** org_model_configs row (§3). `api_key_ciphertext` is NEVER exposed to the browser (D-P3). */
export interface OrgModelConfig {
  id: string;
  org_id: string;
  provider: ProviderIdValue;
  display_name: string;
  api_key_ciphertext: string;
  key_last4: string;
  base_url: string | null;
  default_model: string;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
}

/** The browser-safe projection of `OrgModelConfig` returned by GET /api/llm/configs. */
export interface OrgModelConfigPublic {
  id: string;
  provider: ProviderIdValue;
  display_name: string;
  key_last4: string;
  base_url: string | null;
  default_model: string;
  is_default: boolean;
  is_active: boolean;
  created_at: string;
}

/** workflow_step_configs row (§3) — pins one (org, workflow_type, step_key) to a config. */
export interface WorkflowStepConfig {
  id: string;
  org_id: string;
  workflow_type: WorkflowType;
  step_key: string;
  assigned_provider_config_id: string;
  created_at: string;
}

/** review_decisions row (§4). */
export interface ReviewDecision {
  id: string;
  workflow_id: string;
  reviewer_id: string;
  decision: ReviewDecisionValue;
  comment: string | null;
  decided_at: string;
}

/* -------------------------------------------------------------------------- */
/* Frontend aggregate types — the exact shapes returned by                     */
/* GET /api/workflows/[id]/status/route.ts. The route projects a SUBSET of the */
/* DB rows above, so these are declared explicitly (not the full DB rows).     */
/* -------------------------------------------------------------------------- */

/** The `workflow` object in the /status body (projected subset of `Workflow`). */
export interface WorkflowRow {
  id: string;
  name: string;
  type: WorkflowType;
  status: WorkflowStatus;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

/** One `steps[]` entry in the /status body (projected subset of `WorkflowStep`). */
export interface StepRow {
  id: string;
  step_number: number;
  track: Track;
  name: string;
  status: StepStatus;
  agent_reasoning: string | null;
  input_snapshot: unknown | null;
  output: unknown | null;
  sources: StepSource[] | null;
  model: string | null;
  input_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** The `review` object in the /status body (a full `review_decisions` row, or null). */
export type ReviewRow = ReviewDecision;

/** The full JSON body of GET /api/workflows/[id]/status. */
export interface StatusResponse {
  workflow: WorkflowRow;
  steps: StepRow[];
  review: ReviewRow | null;
}

/** A `workflow_files` row as consumed by the frontend (alias of `WorkflowFile`). */
export type WorkflowFileRow = WorkflowFile;

/* -------------------------------------------------------------------------- */
/* Claude structured-output schemas — §7 Reconciliation.                       */
/* Every schema carries a top-level `reasoning: z.string()` (§5.3).           */
/* -------------------------------------------------------------------------- */

export const MATCH_CONFIDENCES = ["high", "medium", "low"] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];
export const matchConfidenceEnum = z.enum(MATCH_CONFIDENCES);

/** §7 step 3 — match adjudication (Claude confirms/rejects candidate pairs). */
export const matchAdjudicationSchema = z.object({
  reasoning: z.string(),
  confirmedMatches: z.array(
    z.object({
      erpId: z.string(),
      bankId: z.string(),
      confidence: matchConfidenceEnum,
      matchReason: z.string(),
    }),
  ),
  rejectedPairs: z.array(
    z.object({
      erpId: z.string(),
      bankId: z.string(),
      whyNot: z.string(),
    }),
  ),
});
export type MatchAdjudication = z.infer<typeof matchAdjudicationSchema>;

export const EXCEPTION_CATEGORIES = [
  "timing_difference",
  "amount_mismatch",
  "missing_from_erp",
  "missing_from_bank",
  "duplicate",
] as const;
export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];
export const exceptionCategoryEnum = z.enum(EXCEPTION_CATEGORIES);

export const EXCEPTION_SOURCES = ["erp", "bank"] as const;
export type ExceptionSource = (typeof EXCEPTION_SOURCES)[number];
export const exceptionSourceEnum = z.enum(EXCEPTION_SOURCES);

/** §7 step 4 — flag exceptions (classify every unmatched/duplicate item). */
export const exceptionFlagsSchema = z.object({
  reasoning: z.string(),
  flags: z.array(
    z.object({
      id: z.string(),
      source: exceptionSourceEnum,
      category: exceptionCategoryEnum,
      explanation: z.string(),
      recommendation: z.string(),
    }),
  ),
});
export type ExceptionFlags = z.infer<typeof exceptionFlagsSchema>;

/** §7 step 5 — executive narrative for the top of the reconciliation report. */
export const reportNarrativeSchema = z.object({
  reasoning: z.string(),
  narrative: z.string(),
});
export type ReportNarrative = z.infer<typeof reportNarrativeSchema>;

/* -------------------------------------------------------------------------- */
/* Claude structured-output schemas — §8 AP Matching.                          */
/* -------------------------------------------------------------------------- */

/** §8 step 3 — invoice↔PO adjudication (same shape as §7, invoice/po ids). */
export const apMatchAdjudicationSchema = z.object({
  reasoning: z.string(),
  confirmedMatches: z.array(
    z.object({
      invoiceId: z.string(),
      poId: z.string(),
      confidence: matchConfidenceEnum,
      matchReason: z.string(),
    }),
  ),
  rejectedPairs: z.array(
    z.object({
      invoiceId: z.string(),
      poId: z.string(),
      whyNot: z.string(),
    }),
  ),
});
export type ApMatchAdjudication = z.infer<typeof apMatchAdjudicationSchema>;

export const AP_FLAG_CATEGORIES = [
  "no_matching_po",
  "amount_variance",
  "duplicate_invoice",
  "past_due",
] as const;
export type ApFlagCategory = (typeof AP_FLAG_CATEGORIES)[number];
export const apFlagCategoryEnum = z.enum(AP_FLAG_CATEGORIES);

/** §8 step 4 — flag invoices (an invoice may carry multiple flag entries). */
export const apFlagsSchema = z.object({
  reasoning: z.string(),
  flags: z.array(
    z.object({
      invoiceId: z.string(),
      category: apFlagCategoryEnum,
      explanation: z.string(),
      recommendation: z.string(),
    }),
  ),
});
export type ApFlags = z.infer<typeof apFlagsSchema>;

/** §8 step 5 — approval-queue narrative. */
export const apQueueNarrativeSchema = z.object({
  reasoning: z.string(),
  narrative: z.string(),
});
export type ApQueueNarrative = z.infer<typeof apQueueNarrativeSchema>;

/* -------------------------------------------------------------------------- */
/* Claude structured-output schemas — §9 FP&A Commentary.                      */
/* -------------------------------------------------------------------------- */

export const FPA_OVERALL_STATUSES = ["favorable", "unfavorable", "mixed"] as const;
export type FpaOverallStatus = (typeof FPA_OVERALL_STATUSES)[number];
export const fpaOverallStatusEnum = z.enum(FPA_OVERALL_STATUSES);

/** §9 step 4 — per-material-variance commentary (amounts joined back in code). */
export const fpaCommentarySchema = z.object({
  reasoning: z.string(),
  varianceComments: z.array(
    z.object({
      department: z.string(),
      category: z.string(),
      commentary: z.string(),
    }),
  ),
  overallStatus: fpaOverallStatusEnum,
});
export type FpaCommentary = z.infer<typeof fpaCommentarySchema>;

/** §9 step 5 — board deck content. */
export const fpaBoardDeckSchema = z.object({
  reasoning: z.string(),
  executiveSummary: z.string(),
  departmentSummaries: z.array(
    z.object({
      department: z.string(),
      summary: z.string(),
    }),
  ),
});
export type FpaBoardDeck = z.infer<typeof fpaBoardDeckSchema>;

/* -------------------------------------------------------------------------- */
/* Computed output objects (recomputed in code — Claude arithmetic never       */
/* trusted, D3). These drive the OutputPanel, report page, and Excel export.  */
/* -------------------------------------------------------------------------- */

/* --- Reconciliation --- */

export const MATCHED_PAIR_CONFIDENCES = ["exact", "high", "medium", "low"] as const;
export type MatchedPairConfidence = (typeof MATCHED_PAIR_CONFIDENCES)[number];

export interface MatchedPair {
  erpId: string;
  bankId: string;
  amountCents: number;
  confidence: MatchedPairConfidence;
  matchReason: string;
}

export interface ExceptionFlag {
  source: ExceptionSource;
  category: ExceptionCategory;
  explanation: string;
  recommendation: string;
}

export type FlaggedErpTxn = ErpTxn & { flag: ExceptionFlag };
export type FlaggedBankTxn = BankTxn & { flag: ExceptionFlag };
export type DuplicateBankTxn = BankTxn & { duplicateOf: string };

/** §7 step 3 output — the deterministic + adjudicated match result. */
export interface ReconMatchResult {
  matchedPairs: MatchedPair[];
  unmatchedErp: ErpTxn[];
  unmatchedBank: BankTxn[];
  duplicates: DuplicateBankTxn[];
  stats: {
    exactMatches: number;
    adjudicatedMatches: number;
    unmatchedErpCount: number;
    unmatchedBankCount: number;
    duplicateCount: number;
  };
}

export const RECON_STATUSES = ["CLEAN", "EXCEPTIONS_FOUND"] as const;
export type ReconStatus = (typeof RECON_STATUSES)[number];

/** §7 step 5 output — the reconciliation report summary (single source of truth). */
export interface ReconReportSummary {
  totals: {
    erpCount: number;
    erpAmountCents: number;
    bankCount: number;
    bankAmountCents: number;
  };
  matched: {
    count: number;
    amountCents: number;
  };
  matchedPairs: MatchedPair[];
  unmatchedErp: FlaggedErpTxn[];
  unmatchedBank: FlaggedBankTxn[];
  duplicates: DuplicateBankTxn[];
  netDifferenceCents: number; // erp total − bank total (excluding duplicates)
  status: ReconStatus;
  narrative: string;
}

/* --- AP Matching --- */

export interface ApFlag {
  category: ApFlagCategory;
  explanation: string;
  recommendation: string;
}

export interface AutoApproveItem {
  invoiceId: string;
  poId: string;
  amountCents: number;
  vendor: string;
  recommendedAction: "approve";
}

export interface HoldForReviewItem {
  invoice: Invoice;
  poId: string | null;
  flags: ApFlag[];
}

/** §8 step 5 output — the AP approval queue. */
export interface ApApprovalQueue {
  autoApprove: AutoApproveItem[];
  holdForReview: HoldForReviewItem[];
  narrative: string;
  stats: {
    autoApproveCount: number;
    holdCount: number;
    autoApproveAmountCents: number;
    holdAmountCents: number;
  };
}

/* --- FP&A --- */

export interface FpaVarianceComment {
  department: string;
  category: string;
  commentary: string;
}

export interface FpaDepartmentSummary {
  department: string;
  summary: string;
}

/** §9 output — computed variance table + commentary + summaries. */
export interface FpaOutput {
  variances: FpaLine[]; // all lines, material flagged
  materialVariances: FpaLine[]; // top 10 by |variance|
  varianceComments: FpaVarianceComment[];
  overallStatus: FpaOverallStatus;
  executiveSummary: string;
  departmentSummaries: FpaDepartmentSummary[];
  /** Cash/runway section — no cash inputs in demo data (§9); typed-but-empty. */
  cashRunway: null;
}
