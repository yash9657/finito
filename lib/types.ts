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

/**
 * The workflow types that have a DAG. This is the key of `workflowDefinitions`, and adding a
 * value here is a promise that a validated graph exists for it.
 */
export const WORKFLOW_TYPES = [
  "reconciliation",
  "ap_matching",
  "fpa_commentary",
] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export const workflowTypeEnum = z.enum(WORKFLOW_TYPES);

/**
 * An investigation (Plan 5, D-G3) — a `workflows` row driven by the agent loop rather than a DAG.
 *
 * It lives in `workflows` so `harness_events`' foreign key, the org-scoped SELECT policy, the
 * Realtime publication, the cascade delete and the audit certificate all apply to it unchanged;
 * a separate table would have meant duplicating all five.
 *
 * It is deliberately NOT a member of `WORKFLOW_TYPES`, because that union is the key of
 * `workflowDefinitions` and there is no fourth DAG. Splitting the vocabulary keeps
 * "every WorkflowType has a graph" true rather than making it a convention.
 */
export const INVESTIGATION_TYPE = "investigation" as const;

/** Everything `workflows.type` may hold — the DB check constraint's vocabulary (migration 007). */
export const WORKFLOW_ROW_TYPES = [...WORKFLOW_TYPES, INVESTIGATION_TYPE] as const;
export type WorkflowRowType = (typeof WORKFLOW_ROW_TYPES)[number];

/** Narrowing guard: does this row have a DAG the orchestrator can run? */
export function isPipelineType(type: WorkflowRowType): type is WorkflowType {
  return type !== INVESTIGATION_TYPE;
}

export const WORKFLOW_STATUSES = [
  "idle",
  "running",
  // Plan 3, D-A10: suspended waiting on per-action authorization (not an error).
  "awaiting_approval",
  "awaiting_review",
  "approved",
  "rejected",
  "error",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export const workflowStatusEnum = z.enum(WORKFLOW_STATUSES);

export const STEP_STATUSES = [
  "pending",
  "running",
  "awaiting_approval", // Plan 3, D-A10
  "complete",
  "error",
] as const;
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

/* --- Plan 3 — per-action authorization vocabularies (§2, D-A2/D-A4/D-A6). --- */

/** The finance risk taxonomy. Specs live in `lib/approvals/risk.ts` (D-A2). */
export const RISK_CLASSES = [
  "read",
  "writes_ledger",
  "moves_money",
  "external_filing",
] as const;
export type RiskClass = (typeof RISK_CLASSES)[number];
export const riskClassEnum = z.enum(RISK_CLASSES);

/**
 * `action_requests.status`. `auto_approved`/`approved` are authorized; `rejected`
 * (human) and `denied` (structural ceiling — not overridable, D-A4) are resolutions
 * that let the run continue without the action (D-A5). Only `pending` suspends.
 */
export const ACTION_STATUSES = [
  "pending",
  "auto_approved",
  "approved",
  "rejected",
  "denied",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const actionStatusEnum = z.enum(ACTION_STATUSES);

/** Who/what resolved an action. */
export const DECISION_SOURCES = ["standing_rule", "human", "ceiling", "policy"] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];
export const decisionSourceEnum = z.enum(DECISION_SOURCES);

/** Grant tiers (D-A6). Every tier is target-bound; `standing` needs a constraint. */
export const RULE_SCOPES = ["once", "run", "standing"] as const;
export type RuleScope = (typeof RULE_SCOPES)[number];
export const ruleScopeEnum = z.enum(RULE_SCOPES);

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

/* -------------------------------------------------------------------------- */
/* Plan 3 — the action contract (§4, D-A1/D-A3/D-A13).                        */
/* -------------------------------------------------------------------------- */

/**
 * What an approval is bound to (D-A3) — never "the step", never "the action type".
 * Every field comes from source data via deterministic code (D-A1/D3): `counterparty`
 * is the vendor name as parsed, `amountCents` is integer cents (D7/D-A16).
 */
export interface ActionTarget {
  kind: string; // 'invoice'
  id: string; // 'inv-003' (a stable synthetic row id, D8)
  counterparty: string | null;
  amountCents: number | null;
}

/** One consequential act a step wants to perform, proposed BEFORE it runs (D-A1). */
export interface ProposedAction {
  /** Deterministic + unique per workflow (`<action_type>:<target.id>`) — the gate's
   *  idempotency key across resumes (D-A1). */
  actionKey: string;
  actionType: string; // 'approve_invoice_payment'
  riskClass: RiskClass;
  target: ActionTarget;
  /** One-line human-readable description shown in the approval UI + audit trail. */
  summary: string;
  /** Deterministic supporting facts (po id, invoice number, …). No secrets. */
  payload?: Record<string, unknown>;
}

/** The decision a step sees for one of its proposed actions (via `ctx.approvals`). */
export interface ActionDecision {
  actionKey: string;
  actionId: string;
  status: ActionStatus;
  source: DecisionSource | null;
  reason: string | null;
  standingRuleId: string | null;
  decidedBy: string | null;
  /** True only for `auto_approved` / `approved` — step code must fail closed on false. */
  authorized: boolean;
}

/** actionKey → decision, for the actions of one step (D-A3). */
export type ActionDecisionMap = Map<string, ActionDecision>;

export interface StepContext {
  workflowId: string;
  db: SupabaseClient; // admin client
  files: Record<string, ParsedFile>; // keyed by file_type
  priorOutputs: Record<string, unknown>; // step_key -> validated output (D-P5)
  /** Resolve + call the org's provider for this step (D-P1). LLM steps only. */
  llm: LlmFn;
  /**
   * Authorization decisions for THIS step's proposed actions (Plan 3, D-A3). Empty for
   * `read` steps. A missing or unauthorized key means "not authorized" — commit paths
   * must fail closed.
   */
  approvals: ActionDecisionMap;
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

/** One node of a workflow graph (Plan 2 §4.1, D-P5/D-P8; Plan 3 §4, D-A2/D-A3). */
export interface DagStepDefinition {
  key: string; // 'parse_erp' — unique within the workflow
  stepNumber: number; // stable UI order + DB unique constraint (D-P5)
  dependsOn: string[]; // keys; [] = source node
  role: StepRole; // D-P8
  track: Track; // UI layout hint only
  name: string; // display name (unchanged strings from PLAN.md)
  kind: StepKind;
  /**
   * Consequence class (Plan 3, D-A2). Omitted ⇒ `read`. Any non-read step is gated by
   * the permission engine before it runs and MUST declare `proposeActions`
   * (`validateDag` enforces both directions).
   */
  risk?: RiskClass;
  /**
   * The uploaded file this step reads, when it reads exactly one (Plan 4, §1).
   *
   * Declared rather than inferred so the harness loop can synthesize a `normalize_dataset`
   * action naming a specific file, and the dataset verifier can bind that action to the
   * file's content hash. Absent for steps that read prior outputs instead of raw files.
   */
  fileType?: FileType;
  /**
   * The consequential acts this step wants to commit, computed deterministically from
   * files + prior outputs (D-A1/D-A13). Must not call `ctx.llm`. The same helper that
   * derives these must derive the set `run` commits, so gate and commit cannot diverge.
   */
  proposeActions?(ctx: StepContext): Promise<ProposedAction[]>;
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
  /** Widened by Plan 5 (D-G3): an investigation is a workflow row without a DAG. */
  type: WorkflowRowType;
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

/**
 * The agent roles (D-P8; constrained as a closed action-type set by Plan 4, D-H15).
 *
 * `investigator` is the fifth, added by Plan 5 (D-G2). It is here rather than in a parallel
 * vocabulary because that is what makes per-role model assignment work for the agent for free —
 * an org points `investigator` at DeepSeek or its own Ollama box in Settings and resolution
 * tier 2 (`org_role_configs`) does the rest, with no agent-specific plumbing.
 */
export const STEP_ROLES = [
  "parser",
  "matcher",
  "classifier",
  "writer",
  "investigator",
] as const;
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

/* -------------------------------------------------------------------------- */
/* Plan 3 — authorization rows (§2). snake_case as stored.                     */
/* -------------------------------------------------------------------------- */

/**
 * org_approval_policies row (§2, D-A4/D-A8) with defaults applied. `loadPolicy` returns
 * this shape even when the org has no row: all ceilings null + all flags false, which
 * denies nothing and auto-approves nothing, so every consequential action sees a human.
 */
export interface ApprovalPolicy {
  org_id: string;
  /** Absolute ceiling: above this an action is denied and NO click can override (D-A4). */
  hard_deny_above_cents: number | null;
  /** Rule ceiling: a standing rule can never auto-approve above this. */
  auto_approve_max_cents: number | null;
  require_known_counterparty: boolean;
  approved_counterparties: string[];
  /** Four-eyes: the workflow's creator may not resolve its own actions (D-A8). */
  require_separate_approver: boolean;
  updated_by: string | null;
  updated_at: string | null;
}

/** approval_rules row (§2, D-A6) — a tiered, target-bound grant. */
export interface ApprovalRule {
  id: string;
  org_id: string;
  scope: RuleScope;
  workflow_id: string | null; // required for 'once'/'run'; null for 'standing'
  action_type: string;
  target_kind: string;
  target_id: string | null; // required for 'once'
  counterparty: string | null; // null = any counterparty
  max_amount_cents: number | null; // inclusive cap; null = uncapped
  note: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  consumed_at: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** The body accepted when minting a rule (validated by `validateRuleInput`, D-A6). */
export interface ApprovalRuleInput {
  scope: RuleScope;
  workflow_id?: string | null;
  action_type: string;
  target_kind: string;
  target_id?: string | null;
  counterparty?: string | null;
  max_amount_cents?: number | null;
  note?: string | null;
  expires_at?: string | null;
}

/** action_requests row (§2, D-A1) — the durable pending item. */
export interface ActionRequest {
  id: string;
  workflow_id: string;
  step_id: string | null;
  step_key: string;
  action_key: string;
  action_type: string;
  risk_class: RiskClass;
  target: ActionTarget;
  target_kind: string;
  target_id: string;
  counterparty: string | null;
  amount_cents: number | null;
  summary: string;
  payload: Record<string, unknown> | null;
  status: ActionStatus;
  decision_source: DecisionSource | null;
  decision_reason: string | null;
  standing_rule_id: string | null;
  decided_by: string | null;
  comment: string | null;
  proposed_at: string;
  decided_at: string | null;
  committed_at: string | null;
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
/* Plan 4 — the harness event stream (§1, D-H2/D-H7).                          */
/* -------------------------------------------------------------------------- */

/**
 * The event vocabulary (D-H7). Twelve types: the eleven the Plan 4 brief lists plus
 * `action_failed_verification`, which is the one that evidences the gate actually
 * blocking something — an audit trail that can only record successes proves nothing.
 *
 * Ordering here is the lifecycle order of `executeStep` (D-H8), not alphabetical, so the
 * enum reads as the loop it describes.
 */
export const HARNESS_EVENT_TYPES = [
  "step_started",
  "action_proposed",
  "action_verified",
  "action_failed_verification",
  "action_executed",
  "observation_received",
  "step_completed",
  "step_failed",
  "human_review_requested",
  "human_decision",
  "workflow_paused",
  "workflow_resumed",
  /*
   * Plan 5 — the agent loop (D-G11). Six from the brief, plus two that exist for the same reason
   * `action_failed_verification` does: a trail that can only record the happy path proves nothing.
   *
   *   context_compacted      — compaction silently dropping a finding is precisely the failure
   *                            the trail exists to expose.
   *   provider_state_dropped — moving an investigation between providers discards the previous
   *                            one's opaque reasoning state. We drop it and say so (D-G13).
   */
  "agent_turn_started",
  "agent_reasoning",
  "tool_called",
  "tool_returned",
  "agent_answered",
  "agent_terminated",
  "context_compacted",
  "provider_state_dropped",
] as const;
export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number];
export const harnessEventTypeEnum = z.enum(HARNESS_EVENT_TYPES);

/** Who caused the event. Same vocabulary as `audit_log.actor_type` (ActorType). */
export const HARNESS_ACTORS = ["agent", "human", "system"] as const;
export type HarnessActor = (typeof HARNESS_ACTORS)[number];

/**
 * A `harness_events` row (§1). Append-only: there is no code path that updates one, and
 * the DB grants no UPDATE (D-H4). `sequence_number` is allocated by
 * `append_harness_event`, never by a caller (D-H3).
 */
export interface HarnessEvent {
  id: string;
  workflow_id: string;
  step_id: string | null;
  step_key: string | null;
  sequence_number: number;
  event_type: HarnessEventType;
  actor: HarnessActor;
  payload: unknown;
  /** Non-null only on events an LLM generated, which is how usage aggregates filter. */
  provider_used: string | null;
  model_used: string | null;
  input_hash: string | null;
  /**
   * The event that caused this one (Plan 5, D-G9) — OpenHands' `cause` linkage. A `tool_returned`
   * points at its `tool_called`. Ordering alone cannot express that when a turn issues several
   * tool calls in parallel.
   */
  caused_by: string | null;
  /** Which iteration of the agent loop this belongs to. Null for pipeline events (D-G10). */
  turn_number: number | null;
  created_at: string;
}

/* -------------------------------------------------------------------------- */
/* Plan 5 — the investigator agent (§7, D-G4/D-G14/D-G22).                     */
/* -------------------------------------------------------------------------- */

/**
 * The bounds an investigation runs under (D-G22). Org-configurable, but every field is clamped
 * to a non-negotiable ceiling before the loop sees it — see `clampBudget`. An open-ended loop on
 * a metered API is a cost incident waiting to happen, and "the operator can raise it" is not a
 * bound.
 */
export interface InvestigationBudget {
  maxTurns: number;
  maxTokens: number;
  maxWallClockMs: number;
  maxToolCallsPerTurn: number;
  /**
   * How many consequential actions ONE investigation may queue for review.
   *
   * Added after watching a real run: asked "is anything ready for payment?", the agent queued
   * FIFTEEN payment approvals across three turns. Nothing unsafe happened — every one was
   * verified, every one was left pending a human, and each amount came from its own row — so the
   * safety property held exactly as designed. The problem is the reviewer: a queue of fifteen
   * near-identical approvals is precisely how people are trained to rubber-stamp, which is the
   * failure D-H9 exists to prevent, arriving through the front door instead of the back.
   *
   * The other bounds cap what the run COSTS. This one caps what it costs *a person*, which turns
   * out to be the scarcer resource.
   */
  maxRecommendations: number;
}

/**
 * Why the loop stopped. Every value except `answered` produces a PARTIAL answer that says it is
 * partial — a silent stop is the failure mode the bounds exist to prevent.
 */
export const TERMINATION_REASONS = [
  "answered",
  "max_turns",
  "max_tokens",
  "max_wall_clock",
  "loop_detected",
  "no_tool_support",
  "provider_error",
  "error",
] as const;
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/**
 * One figure in a cited answer.
 *
 * The agent supplies the label, the source ids and the operation; **it does not supply the
 * value** (D-G1/D-G14). `valueCents` is computed in TypeScript from the cited rows and
 * substituted into the prose in place of `{{ref}}`. That is what makes "every number is
 * recomputed in code" a checkable property rather than a claim.
 */
export const FIGURE_OPERATIONS = ["sum", "count", "difference", "average"] as const;
export type FigureOperation = (typeof FIGURE_OPERATIONS)[number];

export interface AnswerFigure {
  /** The placeholder token used in the prose, e.g. `total_unmatched`. */
  ref: string;
  label: string;
  operation: FigureOperation;
  /** Source ids the figure is computed over. Validated to resolve to real rows. */
  sourceIds: string[];
  /** Filled in by code after recomputation. Never read from the model. */
  valueCents?: number;
  /** For `count`, the figure is unitless. */
  value?: number;
}

export interface AnswerCitation {
  sourceId: string;
  note: string;
}

/** The final, validated answer stored on `investigations.answer`. */
export interface InvestigationAnswer {
  /** Prose with every `{{ref}}` already replaced by a code-computed figure. */
  prose: string;
  /** The prose as the model wrote it, placeholders intact — kept so the trail can show both. */
  proseTemplate: string;
  findings: { statement: string; sourceIds: string[] }[];
  figures: AnswerFigure[];
  citations: AnswerCitation[];
  /** True when the loop terminated on a bound rather than by answering. */
  partial: boolean;
}

/** An `investigations` row (migration 007). A projection of the stream, never an authority. */
export interface Investigation {
  workflow_id: string;
  org_id: string;
  question: string;
  status: "running" | "answered" | "terminated" | "failed";
  budget: InvestigationBudget;
  answer: InvestigationAnswer | null;
  termination_reason: TerminationReason | null;
  turns_used: number;
  tokens_in: number;
  tokens_out: number;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
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
  type: WorkflowRowType;
  status: WorkflowStatus;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

/**
 * One `steps[]` entry in the /status body (projected subset of `WorkflowStep`).
 * NOTE: `llm_raw` is deliberately excluded (D-P11 / §7) — it is DB-only audit data and
 * never sent to the browser.
 */
export interface StepRow {
  id: string;
  step_number: number;
  step_key: string | null;
  track: Track;
  name: string;
  status: StepStatus;
  agent_reasoning: string | null;
  input_snapshot: unknown | null;
  output: unknown | null;
  sources: StepSource[] | null;
  model: string | null;
  provider_used: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  latency_ms: number | null;
  input_hash: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** The `review` object in the /status body (a full `review_decisions` row, or null). */
export type ReviewRow = ReviewDecision;

/**
 * One `actions[]` entry in the /status body (Plan 3, D-A12). The whole row is safe for
 * the browser — unlike `llm_raw` (D-P11) nothing here is provider or secret material.
 */
export type ActionRequestRow = ActionRequest;

/** The full JSON body of GET /api/workflows/[id]/status. */
export interface StatusResponse {
  workflow: WorkflowRow;
  steps: StepRow[];
  review: ReviewRow | null;
  /** Consequential actions proposed by this run, newest-proposal-last (Plan 3). */
  actions: ActionRequestRow[];
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
  /**
   * How this payment came to be authorized (Plan 3, D-A3): the standing rule that
   * covered it or the human who approved it. Present for every item produced by the
   * gated approval-queue step; optional so legacy rows still type-check.
   */
  authorization?: ActionDecision;
}

export interface HoldForReviewItem {
  invoice: Invoice;
  poId: string | null;
  flags: ApFlag[];
  /**
   * Set when the invoice is held for an AUTHORIZATION reason rather than a data flag —
   * a human rejected the payment, or an org ceiling denied it (Plan 3, D-A5).
   */
  authorization?: ActionDecision;
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
