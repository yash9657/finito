"use client";
import { useState } from "react";
import { Check, ArrowUpRight, FileText } from "lucide-react";
const examples = [
  {
    name: "Reconciliation",
    title: "June cash reconciliation",
    columns: ["Reference", "Source entry", "Amount", "Result"],
    rows: [
      ["ERP-1042", "Northstar · ACH receipt", "$24,800.00", "Matched"],
      ["ERP-1043", "Harbor · supplier payment", "$8,450.00", "Matched"],
      ["BANK-0018", "Bank processing fee", "$125.00", "Review"],
      ["ERP-1045", "Payroll clearing", "$62,400.00", "Matched"],
    ],
    detail: "One exception. A clear next step.",
    body: "A bank fee has no corresponding ERP entry. Review the source records before deciding whether an adjustment is needed.",
    source: "bank_june.csv · row 18",
    next: "Review exception",
    footer: "ERP export ↔ Bank statement",
  },
  {
    name: "Invoice matching",
    title: "June accounts payable review",
    columns: ["Invoice", "Supplier", "Amount", "Result"],
    rows: [
      ["INV-208", "Northstar Systems", "$12,000.00", "Matched"],
      ["INV-209", "Harbor Supply", "$3,250.00", "Matched"],
      ["INV-210", "Meridian Services", "$6,800.00", "Review"],
      ["INV-211", "Atlas Logistics", "$1,840.00", "Matched"],
    ],
    detail: "Evidence before authorization.",
    body: "This invoice exceeds its purchase order. Inspect the difference and hold it for review. An approval here records authorization; it does not send a payment.",
    source: "invoices_june.csv · row 4",
    next: "Review invoice",
    footer: "Purchase orders ↔ Invoices",
  },
  {
    name: "Variance analysis",
    title: "June budget versus actuals",
    columns: ["Department", "Category", "Variance", "Result"],
    rows: [
      ["Engineering", "Software", "$0.00", "On track"],
      ["Operations", "Facilities", "$0.00", "On track"],
      ["Marketing", "Campaigns", "+$8,600.00", "Review"],
      ["Finance", "Professional fees", "$0.00", "On track"],
    ],
    detail: "The variance is known. The cause needs evidence.",
    body: "Campaign spend is above plan. FinFlow calculates the difference and drafts commentary, with the business driver left for management to confirm.",
    source: "actuals_june.csv · row 7",
    next: "Review variance",
    footer: "Budget ↔ Actuals",
  },
];
export function Workpaper() {
  const [selected, setSelected] = useState(0);
  const example = examples[selected];
  return (
    <div className="workpaper" id="product-preview">
      <div className="workpaper-head">
        <div
          className="sample-tabs"
          role="tablist"
          aria-label="Explore a sample workflow"
        >
          {examples.map((item, i) => (
            <button
              key={item.name}
              role="tab"
              id={`sample-tab-${i}`}
              aria-selected={i === selected}
              aria-controls="sample-panel"
              tabIndex={i === selected ? 0 : -1}
              onClick={() => setSelected(i)}
              onKeyDown={(e) => {
                if (
                  ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)
                ) {
                  e.preventDefault();
                  const next =
                    e.key === "Home"
                      ? 0
                      : e.key === "End"
                        ? 2
                        : (selected + (e.key === "ArrowRight" ? 1 : 2)) % 3;
                  setSelected(next);
                  document.getElementById(`sample-tab-${next}`)?.focus();
                }
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          Illustrative data · June 2026
        </span>
      </div>
      <div
        className="workpaper-body"
        id="sample-panel"
        role="tabpanel"
        aria-labelledby={`sample-tab-${selected}`}
      >
        <div className="workpaper-table" tabIndex={0} aria-label="Sample data. Scroll horizontally to view all columns.">
          <p className="mb-3 px-3 text-xs text-muted sm:hidden">Swipe the table to see amounts and results →</p>
          <div className="mb-5 flex items-center gap-2 px-3 text-sm">
            <FileText size={16} className="text-muted" />
            {example.title}
          </div>
          <table>
            <caption className="sr-only">
              {example.title}, illustrative entries
            </caption>
            <thead>
              <tr>
                {example.columns.map((c) => (
                  <th scope="col" key={c}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {example.rows.map((row, i) => (
                <tr key={row[0]} className={i === 2 ? "bg-warning/5" : ""}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={
                        j === 2
                          ? "font-mono"
                          : j === 3
                            ? i === 2
                              ? "text-warning"
                              : "text-accent"
                            : j === 0
                              ? "text-muted"
                              : ""
                      }
                    >
                      {j === 3 && i !== 2 && (
                        <Check size={12} className="mr-1 inline" />
                      )}
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="workpaper-detail" aria-live="polite">
          <span className="flex items-center gap-2 text-xs text-warning">
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Review required
          </span>
          <h3>{example.detail}</h3>
          <p>{example.body}</p>
          <dl>
            <div>
              <dt>Source</dt>
              <dd className="text-right">{example.source}</dd>
            </div>
            <div>
              <dt>Next step</dt>
              <dd>{example.next}</dd>
            </div>
          </dl>
        </div>
      </div>
      <div className="workpaper-foot">
        <span>{example.footer}</span>
        <span className="flex items-center gap-2">
          Source records → Verified calculations → Human review{" "}
          <ArrowUpRight size={13} />
        </span>
      </div>
    </div>
  );
}
