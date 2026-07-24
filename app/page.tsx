export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight text-foreground sm:text-6xl">
        FinFlow
      </h1>
      <p className="mt-4 max-w-md font-mono text-sm text-muted">
        Multi-agent finance automation — watch the agents work.
      </p>
      <span className="mt-8 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-xs text-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        M0 · scaffold
      </span>
    </main>
  );
}
