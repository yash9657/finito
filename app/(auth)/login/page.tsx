"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { Brand } from "@/components/Brand";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserClient } from "@supabase/ssr";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Mode = "signin" | "signup";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setNotice(null);
    setLoading(true);

    // Constructed lazily (on submit) rather than at render time so the page can
    // be statically prerendered at build without the public env vars present.
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );

      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) {
          setError(error.message);
          return;
        }
        router.push("/dashboard");
        router.refresh();
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) {
          setError(error.message);
          return;
        }
        // If email confirmation is disabled, a session is returned immediately.
        if (data.session) {
          router.push("/dashboard");
          router.refresh();
        } else {
          setNotice(
            "Account created. Check your email to confirm, then sign in.",
          );
          setMode("signin");
        }
      }
    } catch {
      setError("Unable to connect. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
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
          <div className="mb-7">
            <h1 className="page-title">
              {mode === "signin" ? "Welcome back." : "Start your workspace."}
            </h1>
            <p className="mt-3 text-sm text-muted">
              {mode === "signin"
                ? "Sign in to pick up where your team left off."
                : "Create an account for your financial work."}
            </p>
          </div>

          <Card className="border-0 bg-transparent">
            <CardHeader className="px-0 pb-6">
              <div className="flex rounded-md border border-border p-1">
                <button
                  type="button"
                  onClick={() => {
                    setMode("signin");
                    setError(null);
                    setNotice(null);
                  }}
                  className={cn(
                    "min-h-11 flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
                    mode === "signin"
                      ? "bg-card-hover text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  Sign in
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode("signup");
                    setError(null);
                    setNotice(null);
                  }}
                  className={cn(
                    "min-h-11 flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
                    mode === "signup"
                      ? "bg-card-hover text-foreground"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  Sign up
                </button>
              </div>
            </CardHeader>

            <CardContent className="px-0">
              <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                {mode === "signup" && (
                  <p className="text-xs leading-5 text-muted">
                    Use a password of at least 12 characters. You may need to
                    confirm your email before signing in.
                  </p>
                )}
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="email"
                    className="text-xs font-medium text-muted"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="h-12 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    placeholder="you@company.com"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="password"
                    className="text-xs font-medium text-muted"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    autoComplete={
                      mode === "signin" ? "current-password" : "new-password"
                    }
                    required
                    minLength={mode === "signup" ? 12 : 6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-12 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    placeholder="••••••••"
                  />
                </div>

                {error && (
                  <p role="alert" className="text-sm text-error">
                    {error}
                  </p>
                )}
                {notice && (
                  <p role="status" className="text-sm text-accent">
                    {notice}
                  </p>
                )}

                <Button
                  type="submit"
                  variant="accent"
                  disabled={loading}
                  className="mt-1"
                >
                  {loading
                    ? "Connecting…"
                    : mode === "signin"
                      ? "Sign in"
                      : "Create account"}
                  {!loading && <ArrowRight size={16} />}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
