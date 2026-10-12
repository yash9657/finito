"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import ApprovalPolicyEditor from "@/components/settings/ApprovalPolicyEditor";
import StandingRulesList from "@/components/settings/StandingRulesList";
import type { ApprovalPolicy, ApprovalRule } from "@/lib/types";
import type { ActionTypeSpec } from "@/lib/approvals/action-types";

export interface RuleRow extends ApprovalRule {
  binding: string;
  state: string;
}

export default function ApprovalsManager({ isAdmin }: { isAdmin: boolean }) {
  const [policy, setPolicy] = React.useState<ApprovalPolicy | null>(null);
  const [rules, setRules] = React.useState<RuleRow[]>([]);
  const [actionTypes, setActionTypes] = React.useState<ActionTypeSpec[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [policyRes, rulesRes] = await Promise.all([
        fetch("/api/approvals/policy"),
        fetch("/api/approvals/rules"),
      ]);
      if (!policyRes.ok || !rulesRes.ok)
        throw new Error(
          "Unable to load approval controls. Check your connection and try again.",
        );
      const [policyBody, rulesBody] = await Promise.all([
        policyRes.json(),
        rulesRes.json(),
      ]);
      setPolicy(policyBody.policy);
      setRules(rulesBody.rules);
      setActionTypes(rulesBody.actionTypes);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load approval controls. Try again.",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex min-w-0 flex-col gap-10">
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-sm text-error"
        >
          {error}
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void reload()}
          >
            Try again
          </Button>
        </div>
      )}
      {loading && (
        <p role="status" className="text-sm text-muted">
          Loading approval controls…
        </p>
      )}
      {policy && (
        <section>
          <h2 className="mb-2 text-lg font-medium">Organization limits</h2>
          <p className="mb-5 max-w-3xl text-sm leading-6 text-muted">
            These limits apply before any approval. A reviewer cannot override a
            blocked action.
          </p>
          <ApprovalPolicyEditor
            policy={policy}
            isAdmin={isAdmin}
            onSaved={reload}
          />
        </section>
      )}
      {policy && (
        <section>
          <h2 className="mb-2 text-lg font-medium">Standing rules</h2>
          <p className="mb-5 max-w-3xl text-sm leading-6 text-muted">
            Authorize a defined set of routine actions in advance. Each rule
            remains subject to organization limits and the workflow’s financial
            checks.
          </p>
          <StandingRulesList
            rules={rules}
            actionTypes={actionTypes}
            isAdmin={isAdmin}
            onChanged={reload}
          />
        </section>
      )}
    </div>
  );
}
