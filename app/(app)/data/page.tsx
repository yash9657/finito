import { Suspense } from "react";
import { DataLibrary } from "@/components/data/DataLibrary";
export default function DataPage() {
  return (
    <Suspense
      fallback={
        <div className="page-container text-muted">Loading your data…</div>
      }
    >
      <DataLibrary />
    </Suspense>
  );
}
