import type {
  ActionRequest,
  Workflow,
  WorkflowStep,
  WorkflowFile,
  ReviewDecision,
  Profile,
} from "@/lib/types";
import { RISK_CLASS_SPECS } from "@/lib/approvals/risk";
import { actionTypeLabel } from "@/lib/approvals/action-types";
import {
  authorizationFooterClause,
  authorizationSummary,
  decisionNarrative,
} from "@/lib/approvals/report";
import { formatCents } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

function modelsUsed(steps: WorkflowStep[]): string[] {
  return [
    ...new Set(
      steps
        .filter((s) => s.provider_used && s.model)
        .map((s) => `${s.provider_used}: ${s.model}`),
    ),
  ].sort();
}
function stepDuration(
  startedAt: string | null,
  completedAt: string | null,
): string {
  if (!startedAt || !completedAt) return "—";
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
function stamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "UTC" }).format(date)} UTC`;
}
function humanLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
const WORKFLOW_LABEL = {
  reconciliation: "Reconciliation",
  ap_matching: "Invoice matching",
  fpa_commentary: "Variance analysis",
  investigation: "Investigation",
};
function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-muted">{label}</dt>
      <dd
        className={`mt-1 whitespace-pre-wrap break-words text-sm leading-6 ${mono ? "break-all font-mono" : ""}`}
      >
        {children}
      </dd>
    </div>
  );
}
export interface AuditTrailProps {
  workflow: Workflow;
  steps: WorkflowStep[];
  files: WorkflowFile[];
  decision: ReviewDecision | null;
  reviewer: Profile | null;
  actions?: ActionRequest[];
  approverEmails?: Record<string, string>;
}

export default function AuditTrail({
  workflow,
  steps,
  files,
  decision,
  reviewer,
  actions = [],
  approverEmails = {},
}: AuditTrailProps) {
  const orderedSteps = [...steps].sort((a, b) => a.step_number - b.step_number);
  const chain = authorizationSummary(actions);
  return (
    <section className="min-w-0 border-t border-border pt-8">
      <header className="mb-8">
        <h2 className="text-xl font-medium tracking-tight">Audit record</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          Source files, processing steps, authorizations, and final review
          recorded for this workflow. All timestamps below are in UTC.
        </p>
      </header>
      <div className="min-w-0 space-y-9">
        <section>
          <h3 className="mb-4 font-medium">Workflow</h3>
          <dl className="grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-2">
            <Field label="Workflow ID" mono>
              {workflow.id}
            </Field>
            <Field label="Type">{WORKFLOW_LABEL[workflow.type]}</Field>
            <Field label="Started">{stamp(workflow.started_at)}</Field>
            <Field label="Completed">{stamp(workflow.completed_at)}</Field>
          </dl>
        </section>
        <section>
          <h3 className="mb-4 font-medium">Source files</h3>
          {files.length === 0 ? (
            <p className="text-sm text-muted">No source files recorded.</p>
          ) : (
            <ul className="divide-y divide-border border-y border-border">
              {files.map((f) => (
                <li key={f.id} className="min-w-0 space-y-3 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-all text-sm font-medium">
                      {f.filename}
                    </p>
                    <span className="shrink-0 text-sm text-muted">
                      {f.size_bytes.toLocaleString("en-US")} bytes
                    </span>
                  </div>
                  <dl className="grid min-w-0 gap-3">
                    <Field label="Source type">{humanLabel(f.file_type)}</Field>
                    <Field label="File fingerprint (SHA-256)" mono>
                      {f.sha256}
                    </Field>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section>
          <h3 className="mb-4 font-medium">Processing steps</h3>
          {orderedSteps.length === 0 ? (
            <p className="text-sm text-muted">No processing steps recorded.</p>
          ) : (
            <ol className="divide-y divide-border border-y border-border">
              {orderedSteps.map((s) => (
                <li key={s.id} className="min-w-0 py-5">
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <span className="text-sm text-muted">
                      Step {s.step_number}
                    </span>
                    <h4 className="min-w-0 break-words text-sm font-medium">
                      {s.name}
                    </h4>
                    <Badge
                      variant={s.status === "complete" ? "accent" : "muted"}
                    >
                      {humanLabel(s.status)}
                    </Badge>
                    <span className="text-sm text-muted sm:ml-auto">
                      {stepDuration(s.started_at, s.completed_at)}
                    </span>
                  </div>
                  <dl className="grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Processing group">
                      {humanLabel(s.track)}
                    </Field>
                    <Field label="Method or model" mono>
                      {s.provider_used && s.model
                        ? `${s.provider_used}: ${s.model}`
                        : "Deterministic calculation"}
                    </Field>
                    <Field label="Model usage">
                      {s.tokens_in === null && s.tokens_out === null
                        ? "No model tokens recorded"
                        : `${s.tokens_in?.toLocaleString("en-US") ?? "—"} input / ${s.tokens_out?.toLocaleString("en-US") ?? "—"} output tokens`}
                    </Field>
                    <Field label="Started">{stamp(s.started_at)}</Field>
                    <Field label="Completed">{stamp(s.completed_at)}</Field>
                    <Field label="Model response time">
                      {s.latency_ms === null
                        ? "—"
                        : `${(s.latency_ms / 1000).toFixed(1)} s`}
                    </Field>
                    <div className="sm:col-span-2 lg:col-span-3">
                      <Field label="Input fingerprint (SHA-256)" mono>
                        {s.input_hash ?? "Not recorded"}
                      </Field>
                    </div>
                  </dl>
                </li>
              ))}
            </ol>
          )}
        </section>
        {actions.length > 0 && (
          <section>
            <h3 className="mb-2 font-medium">Authorization history</h3>
            <p className="mb-4 text-sm leading-6 text-muted">
              These records show authorization decisions. They do not confirm
              that a payment was sent.
            </p>
            <ol className="divide-y divide-border border-y border-border">
              {actions.map((a) => (
                <li key={a.id} className="min-w-0 py-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h4 className="text-sm font-medium">
                      {actionTypeLabel(a.action_type)}
                    </h4>
                    <span className="font-mono text-sm">
                      {a.amount_cents === null
                        ? "Amount not specified"
                        : formatCents(a.amount_cents)}
                    </span>
                  </div>
                  <dl className="grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                    <Field label="Counterparty">{a.counterparty ?? "—"}</Field>
                    <Field label="Risk classification">
                      {RISK_CLASS_SPECS[a.risk_class]?.label ??
                        humanLabel(a.risk_class)}
                    </Field>
                    <Field label="Outcome">{humanLabel(a.status)}</Field>
                    <Field label="Target record" mono>
                      {humanLabel(a.target_kind)} {a.target_id}
                    </Field>
                    <div className="sm:col-span-2">
                      <Field label="Authorization basis">
                        {decisionNarrative(a, approverEmails)}
                      </Field>
                    </div>
                    <Field label="Proposed">{stamp(a.proposed_at)}</Field>
                    <Field label="Decided">{stamp(a.decided_at)}</Field>
                    <Field label="Recorded as complete">
                      {stamp(a.committed_at)}
                    </Field>
                  </dl>
                </li>
              ))}
            </ol>
          </section>
        )}
        <section>
          <h3 className="mb-4 font-medium">Final review</h3>
          {decision ? (
            <dl className="grid min-w-0 gap-x-8 gap-y-4 sm:grid-cols-2">
              <Field label="Reviewer">
                {reviewer?.email ?? decision.reviewer_id}
              </Field>
              <Field label="Decision">{humanLabel(decision.decision)}</Field>
              <Field label="Decided">{stamp(decision.decided_at)}</Field>
              <Field label="Comment">
                {decision.comment?.trim() || "No comment recorded."}
              </Field>
            </dl>
          ) : (
            <p className="text-sm text-muted">No final review recorded.</p>
          )}
        </section>
        <footer className="min-w-0 border-t border-border pt-5 text-sm leading-6 text-muted">
          <p>
            Generated by FinFlow. Source and step fingerprints identify the
            recorded inputs.
          </p>
          <p className="mt-2 break-all">
            Models used:{" "}
            {modelsUsed(orderedSteps).join(", ") || "None recorded"}.
          </p>
          {chain.total > 0 && (
            <p className="mt-2">{authorizationFooterClause(chain)}</p>
          )}
        </footer>
      </div>
    </section>
  );
}
