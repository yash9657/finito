import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { Brand } from "@/components/Brand";
import { AuthProvider } from "@/components/AuthProvider";

// Per-request: Clerk reads the session, and the build has no Clerk keys.
export const dynamic = "force-dynamic";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthProvider>
      <main className="auth-layout">
        <section className="auth-story">
          <div>
            <Brand />
          </div>
          <div>
            <h2>
              A clear line from
              <br />
              source to sign-off.
            </h2>
            <p className="max-w-md text-base leading-7 text-muted">
              Your financial work, with the evidence to stand behind it.
            </p>
            <div className="mt-10 space-y-4">
              {[
                "Reconciliation with source records",
                "Invoice review with approval controls",
                "Variance analysis with verified calculations",
              ].map((item) => (
                <p key={item} className="flex items-center gap-3 text-sm">
                  <Check size={16} className="text-accent" />
                  {item}
                </p>
              ))}
            </div>
          </div>
          <p className="text-xs text-muted">
            FinFlow · Finance, with a clear record.
          </p>
        </section>
        <section className="auth-form">
          <div className="w-full max-w-sm">
            <Link
              href="/"
              className="mb-10 inline-flex min-h-11 items-center gap-2 text-xs text-muted hover:text-foreground"
            >
              <ArrowLeft size={14} />
              Back to FinFlow
            </Link>
            {children}
          </div>
        </section>
      </main>
    </AuthProvider>
  );
}
