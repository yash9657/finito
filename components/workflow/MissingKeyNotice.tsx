"use client";

/**
 * Shared BYOK run-guard notice.
 *
 * Both run call sites (the new-workflow wizard launch step and the ReviewBanner
 * "Re-run" button) gate on `hasStoredKey()` before POSTing `/run`. When no key
 * is stored they render this identical inline notice instead of calling the API,
 * pointing the user to Settings to add their Anthropic key.
 */

import Link from "next/link";
import { KeyRound } from "lucide-react";

export default function MissingKeyNotice({ className }: { className?: string }) {
  return (
    <div
      className={
        "flex flex-wrap items-center gap-2 rounded-md border border-warning/50 bg-warning/10 px-4 py-3 text-sm text-warning" +
        (className ? " " + className : "")
      }
    >
      <KeyRound className="h-4 w-4 shrink-0" />
      <span>Add your Anthropic API key in Settings to run.</span>
      <Link
        href="/settings"
        className="font-medium underline underline-offset-4 hover:opacity-80"
      >
        Go to Settings →
      </Link>
    </div>
  );
}
