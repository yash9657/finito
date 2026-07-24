/**
 * API-key encryption for org LLM configs (Plan 2 §3, D-P2).
 *
 * Keys are encrypted with AES-256-GCM in the Node API-route process — NEVER with
 * `pgp_sym_encrypt`, which would put plaintext into SQL statement text where
 * Supabase statement logging could capture it. The 32-byte AES key is derived
 * (SHA-256) from the server-only env var `LLM_KEY_ENCRYPTION_SECRET`.
 *
 * Ciphertext format (stored in org_model_configs.api_key_ciphertext):
 *   v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * Decryption happens ONLY server-side (router + test route). If the secret is
 * unset, encryption/decryption throw a clear message and the calling route fails
 * closed (500). Rotating the secret invalidates all stored keys (documented in the
 * README) — decrypt failures surface as a re-enter-your-key message, not a crash.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const TAG_BYTES = 16;

/** Thrown when the encryption secret is missing — routes map this to a 500 (fail closed). */
export class MissingEncryptionSecretError extends Error {
  constructor() {
    super(
      "LLM_KEY_ENCRYPTION_SECRET is not set — cannot encrypt or decrypt provider API keys.",
    );
    this.name = "MissingEncryptionSecretError";
  }
}

/** Thrown when stored ciphertext cannot be decrypted (wrong secret / tampered / corrupt). */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

/** Derive the 32-byte AES-256 key from the env secret via SHA-256. */
function deriveKey(): Buffer {
  const secret = process.env.LLM_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.length === 0) {
    throw new MissingEncryptionSecretError();
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

/** True when the encryption secret is configured (routes check this before saving keys). */
export function hasEncryptionSecret(): boolean {
  return (
    typeof process.env.LLM_KEY_ENCRYPTION_SECRET === "string" &&
    process.env.LLM_KEY_ENCRYPTION_SECRET.length > 0
  );
}

/**
 * Encrypt a plaintext API key → `v1:<iv_b64>:<tag_b64>:<ct_b64>`.
 * Empty input returns "" (keyless endpoints like Ollama store no ciphertext).
 */
export function encryptApiKey(plaintext: string): string {
  if (plaintext.length === 0) return "";
  const key = deriveKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a `v1:<iv>:<tag>:<ct>` string back to the plaintext key.
 * Empty input returns "" (keyless config). A tampered tag, wrong secret, or
 * malformed input throws `DecryptionError`.
 */
export function decryptApiKey(stored: string): string {
  if (stored.length === 0) return "";
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionError(`Unrecognized ciphertext format`);
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const key = deriveKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ctB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new DecryptionError("Ciphertext IV or auth tag has the wrong length");
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    // Never echo the underlying OpenSSL error (could vary by build); keep it generic.
    throw new DecryptionError(
      "Stored key cannot be decrypted — re-enter it in Settings → Models",
    );
  }
}

/** Last-4 characters of a key, for display (`key_last4`). Short keys pass through. */
export function keyLast4(plaintext: string): string {
  return plaintext.slice(-4);
}
