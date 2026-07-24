"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * PrintButton — client-only trigger for `window.print()` (PLAN §11.6).
 * Kept separate so the report page can remain a Server Component; the browser
 * print dialog doubles as "Save as PDF" and is driven by the report's
 * `@media print` stylesheet (white background / black text).
 */
export default function PrintButton() {
  return (
    <Button variant="outline" onClick={() => window.print()}>
      <Printer className="h-4 w-4" />
      Print / Save as PDF
    </Button>
  );
}
