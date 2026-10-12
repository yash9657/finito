import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Fingerprint,
  ShieldCheck,
  ListChecks,
} from "lucide-react";
import { Brand } from "@/components/Brand";
import { Workpaper } from "@/components/marketing/Workpaper";
export default function Home() {
  return (
    <div className="marketing">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav
        className="marketing-nav marketing-wrap"
        aria-label="Main navigation"
      >
        <Brand />
        <div className="marketing-links">
          <a href="#workflows">Workflows</a>
          <a href="#controls">Controls</a>
          <Link href="/login">
            Sign in <ArrowUpRight size={14} className="ml-1 inline" />
          </Link>
        </div>
      </nav>
      <main id="main">
        <div className="marketing-wrap">
          <section className="hero">
            <h1>
              A clear line from
              <br />
              <span>source to sign-off.</span>
            </h1>
            <div className="hero-bottom">
              <p>
                Reconcile accounts. Review invoices. Explain variances.{" "}
                <br className="hidden sm:block" />A finance workspace where AI
                does the legwork and your team makes the call.
              </p>
              <Link className="cta" href="/dashboard">
                Open your workspace <ArrowRight size={17} />
              </Link>
            </div>
          </section>
          <Workpaper />
          <section className="landing-section" id="workflows">
            <h2>
              The work behind
              <br />a confident close.
            </h2>
            <div className="workflow-list">
              {[
                [
                  "Reconcile with context.",
                  "Match ERP transactions to bank statements. Separate clean matches from exceptions, with source records available for review.",
                  "reconciliation",
                ],
                [
                  "Give every invoice a second look.",
                  "Match invoices to purchase orders, detect duplicates, and route payment authorization through your team's approval policy.",
                  "ap_matching",
                ],
                [
                  "Put the variance into words.",
                  "Compare budget and actuals with calculations performed in code. Get a draft narrative your team can review and substantiate.",
                  "fpa_commentary",
                ],
              ].map(([title, desc, type]) => (
                <Link
                  className="workflow-link"
                  key={type}
                  href={`/workflows/new?type=${type}`}
                >
                  <h3>{title}</h3>
                  <p>{desc}</p>
                  <ArrowUpRight size={24} />
                </Link>
              ))}
              <Link href="/investigations" className="workflow-link">
                <h3>Follow the question.</h3>
                <p>
                  Investigate your uploaded financial data with bounded tool
                  use, row-level citations, and calculations you can trace.
                </p>
                <ArrowUpRight size={24} />
              </Link>
            </div>
          </section>
        </div>
        <section className="controls-section" id="controls">
          <div className="marketing-wrap controls-grid">
            <div>
              <h2>
                Good judgment
                <br />
                needs good controls.
              </h2>
              <p>
                Give your team a shorter path to a defensible decision. Keep
                evidence, calculations, and approvals together.
              </p>
            </div>
            <div>
              {[
                [
                  Fingerprint,
                  "Start with the source",
                  "File hashes and row references connect results to the data you uploaded.",
                ],
                [
                  ListChecks,
                  "Make the decision explicit",
                  "Set authorization limits, require a separate approver, and keep a record of each decision.",
                ],
                [
                  ShieldCheck,
                  "Choose your models deliberately",
                  "Run open-weight models through Fireworks AI. Configure models for individual workflow steps and inspect their usage.",
                ],
              ].map(([Icon, title, desc]) => {
                const I = Icon as typeof Fingerprint;
                return (
                  <div className="control-row" key={title as string}>
                    <I size={22} strokeWidth={1.5} />
                    <div>
                      <h3>{title as string}</h3>
                      <p>{desc as string}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
        <div className="marketing-wrap">
          <section className="landing-close">
            <div>
              <h2>
                Less chasing numbers.
                <br />
                More understanding them.
              </h2>
              <p className="mt-5 text-sm text-muted">
                Start with your CSV or Excel exports.
              </p>
            </div>
            <Link className="cta" href="/dashboard">
              Get to work <ArrowRight size={18} />
            </Link>
          </section>
        </div>
      </main>
      <footer className="marketing-footer marketing-wrap">
        <Brand />
        <span>Finance, with a clear record.</span>
        <Link href="/login">
          Workspace sign in <ArrowUpRight size={13} className="inline" />
        </Link>
      </footer>
    </div>
  );
}
