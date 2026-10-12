/** Strict decimal arithmetic. Locale interpretation and currency inference are never implicit. */
const SCALE = BigInt("1000000000000");
export function parseExactDecimal(value: unknown): bigint {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("A numeric source value is required");
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) throw new Error("The source number is not exact");
  const text = String(value);
  if (!/^[+-]?\d{1,30}(?:\.\d{1,12})?$/.test(text)) throw new Error("Source values must be plain decimals with at most 30 integer and 12 fractional digits; locale-formatted amounts require an explicit analysis");
  const [whole, fractional = ""] = text.replace(/^[+-]/, "").split(".");
  return (text.startsWith("-") ? -BigInt(1) : BigInt(1)) * (BigInt(whole) * SCALE + BigInt(fractional.padEnd(12, "0")));
}
export function formatExactDecimal(value: bigint): string {
  const abs = value < BigInt(0) ? -value : value;
  const fractional = String(abs % SCALE).padStart(12, "0").replace(/0+$/, "");
  return `${value < BigInt(0) ? "-" : ""}${abs / SCALE}${fractional ? `.${fractional}` : ""}`;
}
export function aggregateExactDecimals(values: unknown[], operation: "sum" | "average" | "difference"): string {
  if (!values.length) throw new Error("An empty source set cannot establish a numeric figure");
  const parsed = values.map(parseExactDecimal);
  let total = parsed.reduce((sum, value) => sum + value, BigInt(0));
  if (operation === "difference") {
    if (parsed.length !== 2) throw new Error("A difference needs exactly two values");
    total = parsed[1] - parsed[0];
  }
  if (operation === "average") {
    const divisor = BigInt(parsed.length);
    if (total % divisor !== BigInt(0)) throw new Error("This average does not have an exact result within 12 decimal places; report it in a labeled analysis artifact with explicit rounding");
    total /= divisor;
  }
  return formatExactDecimal(total);
}
