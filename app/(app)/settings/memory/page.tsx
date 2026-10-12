import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import MemoryManager from "@/components/settings/MemoryManager";

export default function MemorySettingsPage() {
  return (
    <div className="page-container min-w-0">
      <header className="mb-9">
        <Link
          href="/settings"
          className="mb-3 inline-flex min-h-11 items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          Back to settings
        </Link>
        <h1 className="page-title">Memory & history</h1>
        <p className="page-description max-w-3xl">
          Keep your working preferences close and return to the evidence behind
          past questions.
        </p>
      </header>
      <MemoryManager />
    </div>
  );
}
