"use client";

/**
 * AddProviderDialog (Plan 2 §6) — create or edit/rotate an org LLM provider config.
 *
 * Masked key input (shown never again — only last-4 is kept, D-P3); base URL field for
 * ollama/custom with the D-P13 reachability note; default-model prefilled per provider.
 * "Test connection" uses the pre-save test mode and must pass before Save enables, with
 * "Save anyway" as a secondary action for offline setups.
 */

import * as React from "react";
import { Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { PROVIDER_META, PROVIDER_ORDER } from "@/components/settings/providerMeta";
import { cn } from "@/lib/utils";
import type { OrgModelConfigPublic, ProviderIdValue } from "@/lib/types";

const INPUT =
  "w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; modelUsed?: string }
  | { kind: "fail"; error?: string };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: OrgModelConfigPublic | null;
  onSaved: () => void;
}

export default function AddProviderDialog({ open, onOpenChange, editing, onSaved }: Props) {
  const [provider, setProvider] = React.useState<ProviderIdValue>("anthropic");
  const [displayName, setDisplayName] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [defaultModel, setDefaultModel] = React.useState(PROVIDER_META.anthropic.defaultModel);
  const [isDefault, setIsDefault] = React.useState(false);
  const [test, setTest] = React.useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const meta = PROVIDER_META[provider];

  // Reset the form whenever the dialog opens (either fresh or prefilled from `editing`).
  React.useEffect(() => {
    if (!open) return;
    if (editing) {
      setProvider(editing.provider);
      setDisplayName(editing.display_name);
      setApiKey("");
      setBaseUrl(editing.base_url ?? "");
      setDefaultModel(editing.default_model);
      setIsDefault(editing.is_default);
    } else {
      setProvider("anthropic");
      setDisplayName("");
      setApiKey("");
      setBaseUrl("");
      setDefaultModel(PROVIDER_META.anthropic.defaultModel);
      setIsDefault(false);
    }
    setTest({ kind: "idle" });
    setError(null);
  }, [open, editing]);

  function onProviderChange(next: ProviderIdValue) {
    setProvider(next);
    setDefaultModel(PROVIDER_META[next].defaultModel);
    setTest({ kind: "idle" });
  }

  function invalidate() {
    setTest({ kind: "idle" });
  }

  async function runTest() {
    setTest({ kind: "testing" });
    setError(null);
    try {
      const res = await fetch("/api/llm/configs/new/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          api_key: apiKey || undefined,
          base_url: baseUrl || undefined,
          default_model: defaultModel,
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; modelUsed?: string; error?: string }
        | null;
      if (res.ok && body?.ok) setTest({ kind: "ok", modelUsed: body.modelUsed });
      else setTest({ kind: "fail", error: body?.error });
    } catch {
      setTest({ kind: "fail", error: "Could not reach the server" });
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        provider,
        display_name: displayName,
        default_model: defaultModel,
        is_default: isDefault,
      };
      if (apiKey) payload.api_key = apiKey;
      if (baseUrl) payload.base_url = baseUrl;

      const url = editing ? `/api/llm/configs/${editing.id}` : "/api/llm/configs";
      const method = editing ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save provider");
      }
      onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save provider");
    } finally {
      setSaving(false);
    }
  }

  const canSave =
    displayName.trim().length > 0 &&
    defaultModel.trim().length > 0 &&
    (!meta.needsBaseUrl || baseUrl.trim().length > 0) &&
    // On create, keyed providers need a key; on edit, an unchanged key is fine.
    (editing ? true : !meta.needsKey || apiKey.trim().length > 0);

  const testPassed = test.kind === "ok";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? "Edit provider" : "Add provider"}</DialogTitle>
          <DialogDescription>
            Keys are encrypted at rest and shown never again — only the last 4 characters
            are kept for display.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <Field label="Provider">
            <select
              value={provider}
              disabled={!!editing}
              onChange={(e) => onProviderChange(e.target.value as ProviderIdValue)}
              className="w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              {PROVIDER_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_META[p].label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Display name">
            <input
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                invalidate();
              }}
              placeholder="Anthropic (prod key)"
              className={INPUT}
            />
          </Field>

          {(meta.needsKey || provider === "custom") && (
            <Field label={editing ? "API key (leave blank to keep current)" : "API key"}>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  invalidate();
                }}
                placeholder={editing ? "•••• (unchanged)" : "sk-…"}
                className={cn(INPUT, "font-mono")}
              />
            </Field>
          )}

          {meta.needsBaseUrl && (
            <Field label="Base URL">
              <input
                value={baseUrl}
                onChange={(e) => {
                  setBaseUrl(e.target.value);
                  invalidate();
                }}
                placeholder="http://localhost:11434"
                className={cn(INPUT, "font-mono")}
              />
              <p className="mt-1 text-xs text-muted">
                Must be reachable from the FinFlow server (D-P13) — the hosted product
                cannot reach a customer&apos;s laptop.
              </p>
            </Field>
          )}

          <Field label="Default model">
            <input
              value={defaultModel}
              onChange={(e) => {
                setDefaultModel(e.target.value);
                invalidate();
              }}
              placeholder="model id"
              className={cn(INPUT, "font-mono")}
            />
          </Field>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setIsDefault(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
            Set as organization default
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={runTest} disabled={test.kind === "testing" || !canSave}>
              {test.kind === "testing" ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Test connection
            </Button>
            {test.kind === "ok" && (
              <span className="flex items-center gap-1 text-xs text-accent">
                <Check className="h-3.5 w-3.5" /> Connected
                {test.modelUsed ? ` (${test.modelUsed})` : ""}
              </span>
            )}
            {test.kind === "fail" && (
              <span className="flex items-center gap-1 text-xs text-error">
                <X className="h-3.5 w-3.5" /> {test.error ?? "Failed"}
              </span>
            )}
          </div>

          {error && <p className="font-mono text-xs text-error">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          {testPassed ? (
            <Button variant="accent" onClick={save} disabled={!canSave || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          ) : (
            <Button variant="outline" onClick={save} disabled={!canSave || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save anyway
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </div>
  );
}
