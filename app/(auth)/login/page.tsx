"use client";

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
    setError(null);
    setNotice(null);
    setLoading(true);

    // Constructed lazily (on submit) rather than at render time so the page can
    // be statically prerendered at build without the public env vars present.
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );

    try {
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
          setNotice("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
        }
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            FinFlow
          </h1>
          <p className="mt-2 font-mono text-xs text-muted">
            Multi-agent finance automation
          </p>
        </div>

        <Card>
          <CardHeader>
            <div className="flex rounded-md border border-border p-1">
              <button
                type="button"
                onClick={() => {
                  setMode("signin");
                  setError(null);
                  setNotice(null);
                }}
                className={cn(
                  "flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === "signin"
                    ? "bg-card text-foreground"
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
                  "flex-1 rounded px-3 py-1.5 text-sm font-medium transition-colors",
                  mode === "signup"
                    ? "bg-card text-foreground"
                    : "text-muted hover:text-foreground",
                )}
              >
                Sign up
              </button>
            </div>
          </CardHeader>

          <CardContent>
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  placeholder="••••••••"
                />
              </div>

              {error && (
                <p className="font-mono text-xs text-error">{error}</p>
              )}
              {notice && (
                <p className="font-mono text-xs text-accent">{notice}</p>
              )}

              <Button
                type="submit"
                variant="accent"
                disabled={loading}
                className="mt-1"
              >
                {loading
                  ? "…"
                  : mode === "signin"
                    ? "Sign in"
                    : "Create account"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
