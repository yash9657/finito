"use client";

/**
 * ApiKeyManager (BYOK).
 *
 * Client sub-component of the (Server Component) settings page. Lets the user
 * enter, save, clear and test their own Anthropic API key. The key is held in
 * this browser's localStorage only (`finflow_anthropic_key`) and is sent to the
 * server exclusively via the `x-anthropic-api-key` header (see lib/anthropic-key).
 * It is never persisted or logged server-side.
 */

import * as React from "react";
import { Loader2, Check, X, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getStoredKey,
  setStoredKey,
  clearStoredKey,
  runHeaders,
} from "@/lib/anthropic-key";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "valid" }
  | { kind: "invalid"; message?: string };

export default function ApiKeyManager() {
  const [value, setValue] = React.useState("");
  const [saved, setSaved] = React.useState(false);
  const [test, setTest] = React.useState<TestState>({ kind: "idle" });

  // Prefill from localStorage after mount (SSR-safe: getStoredKey returns null on the server).
  React.useEffect(() => {
    const existing = getStoredKey();
    if (existing) setValue(existing);
  }, []);

  function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    setSaved(false);
    setTest({ kind: "idle" });
  }

  function onSave() {
    setStoredKey(value);
    setSaved(true);
    setTest({ kind: "idle" });
  }

  function onClear() {
    clearStoredKey();
    setValue("");
    setSaved(false);
    setTest({ kind: "idle" });
  }

  async function onTest() {
    // Persist first so runHeaders() reflects what the user typed, then validate.
    setStoredKey(value);
    setSaved(true);
    setTest({ kind: "testing" });
    try {
      const res = await fetch("/api/anthropic/test-key", {
        method: "POST",
        headers: runHeaders(),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (res.ok && body?.ok) {
        setTest({ kind: "valid" });
      } else {
        setTest({ kind: "invalid", message: body?.error });
      }
    } catch {
      setTest({ kind: "invalid", message: "Could not reach the server" });
    }
  }

  const canAct = value.trim().length > 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted">
          Anthropic API key
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <input
          type="password"
          value={value}
          onChange={onChange}
          placeholder="sk-ant-…"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="accent" onClick={onSave} disabled={!canAct}>
            Save
          </Button>
          <Button
            variant="outline"
            onClick={onTest}
            disabled={!canAct || test.kind === "testing"}
          >
            {test.kind === "testing" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Test key
          </Button>
          <Button variant="ghost" onClick={onClear}>
            Clear
          </Button>

          {saved && test.kind === "idle" && (
            <span className="text-xs text-muted">Saved to this browser.</span>
          )}
          {test.kind === "valid" && (
            <span className="flex items-center gap-1 text-xs text-accent">
              <Check className="h-3.5 w-3.5" /> Valid
            </span>
          )}
          {test.kind === "invalid" && (
            <span className="flex items-center gap-1 text-xs text-error">
              <X className="h-3.5 w-3.5" /> Invalid
              {test.message ? ` — ${test.message}` : ""}
            </span>
          )}
        </div>

        <div className="flex items-start gap-2 rounded-md border border-border bg-card/50 px-3 py-2.5 text-xs leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <span>
            Your key is stored only in this browser and sent directly to
            Anthropic for each run over HTTPS. It is never saved on the FinFlow
            server.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
