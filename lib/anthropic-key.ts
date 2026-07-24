/**
 * BYOK (Bring Your Own Key) client helper.
 *
 * The user's Anthropic API key lives ONLY in this browser's localStorage under
 * `finflow_anthropic_key`. It is attached to run requests via the
 * `x-anthropic-api-key` header (see `runHeaders`) and sent directly to the
 * FinFlow server, which uses it transiently and never persists or logs it.
 *
 * These helpers are client-only. Every accessor guards for SSR
 * (`typeof window === "undefined"`) so importing this module in a Server
 * Component or during prerender is safe (reads return null, writes no-op).
 */

const STORAGE_KEY = "finflow_anthropic_key";
const HEADER_NAME = "x-anthropic-api-key";

/** Read the stored key, or null when absent / on the server. */
export function getStoredKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Persist the key to this browser only. Empty/whitespace clears it. */
export function setStoredKey(k: string): void {
  if (typeof window === "undefined") return;
  try {
    const trimmed = k.trim();
    if (trimmed.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, trimmed);
    }
  } catch {
    /* localStorage unavailable (private mode / quota) — no-op */
  }
}

/** Remove the key from this browser. */
export function clearStoredKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

/** True when a non-empty key is stored in this browser. */
export function hasStoredKey(): boolean {
  return getStoredKey() !== null;
}

/**
 * Headers to attach to run/validation requests. Returns
 * `{ 'x-anthropic-api-key': key }` when a key is present, otherwise `{}`.
 * The key is only ever sent as a header — never in a JSON body — so it can't
 * land in a request-body log or an input_snapshot.
 */
export function runHeaders(): Record<string, string> {
  const key = getStoredKey();
  return key ? { [HEADER_NAME]: key } : {};
}
