/**
 * base_url validation for ollama/custom providers (Plan 2 §D-P13).
 *
 * `base_url` must parse as an http/https URL and be reachable FROM the FinFlow server
 * process. SSRF guard: when `NODE_ENV === 'production'` AND the deployment sets
 * `LLM_BLOCK_PRIVATE_URLS=1`, RFC-1918 / loopback / link-local hosts are rejected at
 * config-save time. Default off so self-hosters can point at http://localhost:11434 or
 * a VPC endpoint.
 */

/** Returns an error message when the URL is invalid, or null when it is acceptable. */
export function validateBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Base URL must be a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Base URL must use http or https";
  }

  const blockPrivate =
    process.env.NODE_ENV === "production" && process.env.LLM_BLOCK_PRIVATE_URLS === "1";
  if (blockPrivate && isPrivateHost(url.hostname)) {
    return "Base URL points at a private/localhost address, which is blocked on this deployment";
  }
  return null;
}

/** True for localhost / loopback / RFC-1918 / link-local hosts. */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  // Unique-local IPv6 (fc00::/7) and link-local (fe80::/10).
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // link-local
    if (a === 0) return true;
  }
  return false;
}
