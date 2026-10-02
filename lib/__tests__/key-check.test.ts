/**
 * Key-verification classification.
 *
 * The old "Save + Verify" returned a bare boolean, so every failure mode
 * collapsed into "rejected that key":
 *
 *   - A 429 PROVES the key authenticated, yet it was reported as invalid.
 *     On a free tier (Groq, Gemini) that's easy to hit while setting up, and
 *     the user would delete a perfectly good key.
 *   - A 404 caused by OUR stale model catalog was blamed on the user's key.
 *   - A network blip was blamed on the user's key.
 *
 * The rule these tests lock in: `authenticated` decides whether the key is
 * kept; `ok` only decides the tone of the message.
 */
import { describe, it, expect } from "vitest";
import { LLMError, classifyKeyCheckError } from "../providers/types";

const P = "Groq";
const M = "llama-3.1-8b-instant";

describe("classifyKeyCheckError", () => {
  it("treats 401 as a genuinely bad key", () => {
    const r = classifyKeyCheckError(new LLMError("Invalid API Key", 401, "groq"), P, M);
    expect(r.authenticated).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected this key/i);
  });

  it("treats 403 as a genuinely bad key", () => {
    expect(classifyKeyCheckError(new LLMError("Forbidden", 403, "groq"), P, M).authenticated).toBe(false);
  });

  it("treats 429 as SUCCESS — the key authenticated, it's just throttled", () => {
    const r = classifyKeyCheckError(new LLMError("Rate limit", 429, "groq"), P, M);
    expect(r.authenticated).toBe(true);
    expect(r.ok).toBe(true); // key is usable; caller must save it
    expect(r.message).toMatch(/rate-limit/i);
  });

  it("blames OUR catalog, not the user, for a 404 model", () => {
    const r = classifyKeyCheckError(new LLMError("model not found", 404, "groq"), P, M);
    expect(r.authenticated).toBe(true); // key must be saved
    expect(r.ok).toBe(false);
    expect(r.message).toContain(M);
    expect(r.message).toMatch(/not your key/i);
  });

  it("keeps the key on a provider 5xx", () => {
    for (const status of [500, 502, 503, 529]) {
      const r = classifyKeyCheckError(new LLMError("boom", status, "groq"), P, M);
      expect(r.authenticated, `status ${status}`).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  it("keeps the key when the account is out of credit (402)", () => {
    const r = classifyKeyCheckError(new LLMError("insufficient balance", 402, "groq"), P, M);
    expect(r.authenticated).toBe(true);
    expect(r.message).toMatch(/credit|quota/i);
  });

  it("does not claim the key is bad when the network failed", () => {
    // No status = we never reached the provider, so we know nothing about the key.
    const r = classifyKeyCheckError(new TypeError("Failed to fetch"), P, M);
    expect(r.authenticated).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/couldn't reach/i);
    expect(r.message).not.toMatch(/rejected/i);
  });

  it("always returns a non-empty user-facing message", () => {
    const cases: unknown[] = [
      new LLMError("x", 401), new LLMError("x", 429), new LLMError("x", 404),
      new LLMError("x", 500), new LLMError("x", 418), new Error("plain"), "not an error", null,
    ];
    for (const c of cases) {
      const r = classifyKeyCheckError(c, P, M);
      expect(r.message.length, `case ${String(c)}`).toBeGreaterThan(0);
      expect(typeof r.ok).toBe("boolean");
      expect(typeof r.authenticated).toBe("boolean");
    }
  });

  it("names the provider so a 9-provider page stays unambiguous", () => {
    expect(classifyKeyCheckError(new LLMError("x", 401), "Cerebras", M).message).toContain("Cerebras");
    expect(classifyKeyCheckError(new LLMError("x", 500), "Mistral", M).message).toContain("Mistral");
  });

  it("surfaces the status for unexpected codes rather than swallowing it", () => {
    const r = classifyKeyCheckError(new LLMError("teapot", 418, "groq"), P, M);
    expect(r.status).toBe(418);
    expect(r.message).toContain("418");
  });

  // --- regression: caught by actually clicking the button, not by review ---
  it("detects a bad Gemini key even though Google returns 400, not 401", () => {
    // Verbatim from the live API. Classifying on status alone reported this as
    // "Key appears valid — saved", the exact opposite of the truth.
    const r = classifyKeyCheckError(
      new LLMError("API key not valid. Please pass a valid API key.", 400, "google"),
      "Google Gemini",
      "gemini-3.5-flash-lite"
    );
    expect(r.authenticated).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected this key/i);
  });

  it("recognises auth-failure wording from any provider regardless of status", () => {
    const phrasings = [
      "Incorrect API key provided",
      "invalid_api_key",
      "Unauthorized",
      "authentication failed",
      "permission denied for this resource",
      "API key expired. Please renew the API key.",
    ];
    for (const msg of phrasings) {
      const r = classifyKeyCheckError(new LLMError(msg, 400, "x"), P, M);
      expect(r.authenticated, msg).toBe(false);
    }
  });

  it("does not save the key on a generic 400", () => {
    const r = classifyKeyCheckError(new LLMError("unsupported parameter: temperature", 400, "openai"), P, M);
    expect(r.authenticated).toBe(false);
    expect(r.message).toMatch(/NOT saved/);
  });

  it("does not double up sentence punctuation", () => {
    const r = classifyKeyCheckError(new LLMError("Something failed.", 500, "x"), P, M);
    expect(r.message).not.toMatch(/\.\./);
  });
});
