/**
 * Display formatting helpers (PLAN §11/§12).
 *
 * Money is integer cents everywhere past the parser (D7); these functions are the
 * only place cents become human-readable dollars. Excel export uses `centsToDollars`
 * so the workbook holds real numbers, not strings.
 */

/** Integer cents → `$1,234.50`. Negatives render as `-$1,234.50`. */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const remainder = (abs % 100).toString().padStart(2, "0");
  const body = `$${dollars}.${remainder}`;
  return negative ? `-${body}` : body;
}

/** Integer cents → a plain dollars number (2dp) for numeric cells in the Excel report. */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** ISO date/timestamp → `Jun 23, 2026`. Calendar date is stable (formatted in UTC). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(d);
}

/** ISO timestamp → `14:32:07` (24h). Used in the activity feed and step cards. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
}

/** ISO timestamp → `Jun 23, 2026 14:32:07`. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatDate(iso)} ${formatTime(iso)}`;
}

/**
 * Signed percentage for variance tables (`+12.3%`, `-4.0%`).
 * A `null` pct (division by a zero budget) renders as an em dash.
 */
export function formatPercent(
  pct: number | null,
  opts?: { decimals?: number },
): string {
  if (pct === null || Number.isNaN(pct)) return "—";
  const decimals = opts?.decimals ?? 1;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(decimals)}%`;
}

/** First 12 chars of a hex hash — the display form of a SHA-256 input hash. */
export function shortHash(hex: string): string {
  return hex.slice(0, 12);
}
