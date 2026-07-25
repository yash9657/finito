"use client";

/**
 * ApprovalsManager (Plan 3 §6) — client shell for Settings → Approvals. Composes the
 * ceiling editor (`ApprovalPolicyEditor`) and the standing-grant list
 * (`StandingRulesList`), both fed from /api/approvals/*.
 */

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
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

  const reload = React.useCallback(async () => {
    const [policyRes, rulesRes] = await Promise.all([
      fetch("/api/approvals/policy"),
      fetch("/api/approvals/rules"),
    ]);
    if (policyRes.ok) {
      const body = (await policyRes.json()) as { policy: ApprovalPolicy };
      setPolicy(body.policy);
    }
    if (rulesRes.ok) {
      const body = (await rulesRes.json()) as { rules: RuleRow[]; actionTypes: ActionTypeSpec[] };
      setRules(body.rules);
      setActionTypes(body.actionTypes);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex flex-col gap-8">
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Structural ceilings</h2>
        {policy === null ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted">Loading…</CardContent>
          </Card>
        ) : (
          <ApprovalPolicyEditor policy={policy} isAdmin={isAdmin} onSaved={reload} />
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium text-muted">Standing rules</h2>
        <StandingRulesList
          rules={rules}
          actionTypes={actionTypes}
          isAdmin={isAdmin}
          onChanged={reload}
        />
      </section>
    </div>
  );
}
