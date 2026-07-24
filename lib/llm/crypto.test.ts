import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DecryptionError,
  MissingEncryptionSecretError,
  decryptApiKey,
  encryptApiKey,
  hasEncryptionSecret,
  keyLast4,
} from "@/lib/llm/crypto";

const SECRET = "test-secret-for-crypto-roundtrip-0123456789";

describe("lib/llm/crypto", () => {
  const original = process.env.LLM_KEY_ENCRYPTION_SECRET;

  beforeEach(() => {
    process.env.LLM_KEY_ENCRYPTION_SECRET = SECRET;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.LLM_KEY_ENCRYPTION_SECRET;
    else process.env.LLM_KEY_ENCRYPTION_SECRET = original;
  });

  it("round-trips a plaintext key through encrypt → decrypt", () => {
    const plaintext = "sk-ant-api03-abcdefABCDEF1234567890";
    const ct = encryptApiKey(plaintext);
    expect(ct.startsWith("v1:")).toBe(true);
    expect(ct).not.toContain(plaintext);
    expect(decryptApiKey(ct)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV) but decrypts equally", () => {
    const plaintext = "sk-openai-XYZ";
    const a = encryptApiKey(plaintext);
    const b = encryptApiKey(plaintext);
    expect(a).not.toBe(b);
    expect(decryptApiKey(a)).toBe(plaintext);
    expect(decryptApiKey(b)).toBe(plaintext);
  });

  it("returns '' for empty input on both directions (keyless endpoints)", () => {
    expect(encryptApiKey("")).toBe("");
    expect(decryptApiKey("")).toBe("");
  });

  it("throws when the auth tag is tampered", () => {
    const ct = encryptApiKey("sk-tamper-me");
    const parts = ct.split(":");
    // Flip a byte in the tag segment.
    const tag = Buffer.from(parts[2], "base64");
    tag[0] = tag[0] ^ 0xff;
    parts[2] = tag.toString("base64");
    expect(() => decryptApiKey(parts.join(":"))).toThrow(DecryptionError);
  });

  it("throws when decrypted with a different secret", () => {
    const ct = encryptApiKey("sk-secret-rotation");
    process.env.LLM_KEY_ENCRYPTION_SECRET = "a-completely-different-secret-value";
    expect(() => decryptApiKey(ct)).toThrow(DecryptionError);
  });

  it("rejects malformed ciphertext formats", () => {
    expect(() => decryptApiKey("not-a-valid-ciphertext")).toThrow(DecryptionError);
    expect(() => decryptApiKey("v2:a:b:c")).toThrow(DecryptionError);
  });

  it("throws MissingEncryptionSecretError when the secret is unset", () => {
    delete process.env.LLM_KEY_ENCRYPTION_SECRET;
    expect(hasEncryptionSecret()).toBe(false);
    expect(() => encryptApiKey("sk-anything")).toThrow(MissingEncryptionSecretError);
    expect(() => decryptApiKey("v1:a:b:c")).toThrow(MissingEncryptionSecretError);
  });

  it("keyLast4 returns the trailing 4 characters", () => {
    expect(keyLast4("sk-ant-xyza8f2")).toBe("a8f2");
    expect(keyLast4("ab")).toBe("ab");
  });
});
