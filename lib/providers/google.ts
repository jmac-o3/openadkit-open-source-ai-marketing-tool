import { LLMError, SSE_EVENT_DELIMITER, classifyKeyCheckError, type KeyCheckResult, type LLMCallOptions, type LLMResult, type LLMUsage, type Provider, type StreamHandlers } from "./types";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

function toGeminiBody(opts: LLMCallOptions) {
  const contents = opts.messages.map((m) => {
    const role = m.role === "assistant" ? "model" : "user";
    if (typeof m.content === "string") return { role, parts: [{ text: m.content }] };
    return {
      role,
      parts: m.content.map((p) =>
        p.type === "text"
          ? { text: p.text }
          : { inlineData: { mimeType: p.media_type, data: p.data } }
      ),
    };
  });
  const body: any = {
    contents,
    generationConfig: {
      maxOutputTokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.7,
    },
  };
  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }
  return body;
}

async function readError(res: Response): Promise<LLMError> {
  // Read the body ONCE — we need it both for the retry delay and for the
  // message, and Response bodies can only be consumed a single time.
  let body: any = null;
  try {
    body = await res.clone().json();
  } catch {
    /* non-JSON error body */
  }

  // 429 retry tracking: Gemini puts retryDelay in error.details[].retryDelay
  // (e.g. "15.66s"). We also accept the Retry-After header as a fallback.
  let retryPrefix = "";
  if (res.status === 429) {
    const details: any[] = body?.error?.details ?? [];
    const retryInfo = details.find((d) => typeof d?.retryDelay === "string");
    const delayStr = retryInfo?.retryDelay ?? res.headers.get("retry-after") ?? "60s";
    const seconds = parseFloat(String(delayStr).replace(/s$/, "")) || 60;
    // Surface the wait to the USER, not just to the quota tracker. Gemini was
    // the only provider that recorded the retry delay internally and then threw
    // it away — so a rate-limited Gemini user saw a bare quota message with no
    // indication of how long to wait, while Anthropic/OpenAI users got one.
    retryPrefix = `Rate limit — retry in ${Math.ceil(seconds)}s. `;
    try {
      const { recordRateLimitHit } = await import("../quota-tracker");
      recordRateLimitHit("google", seconds);
    } catch {}
  }

  const detail = body?.error?.message ?? res.statusText;
  return new LLMError(retryPrefix + detail, res.status, "google");
}

function usageFrom(body: any): LLMUsage | null {
  if (!body?.usageMetadata) return null;
  return {
    input_tokens: body.usageMetadata.promptTokenCount ?? 0,
    // 2.5 models bill thinking tokens separately; include them so output isn't undercounted.
    output_tokens: (body.usageMetadata.candidatesTokenCount ?? 0) + (body.usageMetadata.thoughtsTokenCount ?? 0),
  };
}

async function call(opts: LLMCallOptions): Promise<LLMResult> {
  const url = `${API_BASE}/models/${opts.model}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify(toGeminiBody(opts)),
    signal: opts.signal,
  });
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  const text = (body?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? "")
    .join("");
  return { text, usage: usageFrom(body), modelId: opts.model };
}

async function stream(opts: LLMCallOptions, handlers: StreamHandlers): Promise<LLMResult> {
  const url = `${API_BASE}/models/${opts.model}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
    body: JSON.stringify(toGeminiBody(opts)),
    signal: opts.signal,
  });
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new LLMError("Streaming response missing body", undefined, "google");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  let usage: LLMUsage | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Gemini terminates SSE events with CRLF CRLF, not LF LF. Splitting on
      // "\n\n" therefore NEVER matched: every chunk stayed in the buffer, no
      // event was ever parsed, and the stream produced zero deltas — so every
      // Gemini generation came back empty and then failed schema validation.
      // (The old "Gemini occasionally returns empty text" comment elsewhere in
      // the codebase was this bug, misdiagnosed as intermittent.)
      const events = buffer.split(SSE_EVENT_DELIMITER);
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const dataLines = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
        for (const raw of dataLines) {
          const line = raw.trim();
          if (!line || line === "[DONE]") continue;
          try {
            const evt = JSON.parse(line);
            // Surface mid-stream failures instead of returning a truncated result.
            if (evt?.error) {
              throw new LLMError(evt.error?.message ?? "stream error", undefined, "google");
            }
            const blockReason = evt?.promptFeedback?.blockReason;
            if (blockReason) {
              throw new LLMError(`Blocked by Gemini safety filter: ${blockReason}`, undefined, "google");
            }
            const finishReason = evt?.candidates?.[0]?.finishReason;
            if (finishReason === "SAFETY" || finishReason === "RECITATION") {
              throw new LLMError(`Generation stopped: ${finishReason}`, undefined, "google");
            }
            const parts = evt?.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const p of parts) {
                if (typeof p?.text === "string" && p.text) {
                  full += p.text;
                  handlers.onDelta?.(p.text);
                }
              }
            }
            const u = usageFrom(evt);
            if (u) {
              usage = u;
              handlers.onUsage?.(u);
            }
          } catch (err) {
            if (err instanceof LLMError) throw err;
          }
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  handlers.onDone?.(full);
  return { text: full, usage, modelId: opts.model };
}

const TEST_MODEL = "gemini-3.5-flash-lite";
async function testKey(apiKey: string): Promise<KeyCheckResult> {
  try {
    await call({
      apiKey,
      model: TEST_MODEL,
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 4,
    });
    return { ok: true, authenticated: true, modelId: TEST_MODEL, message: "Verified — key works." };
  } catch (e) {
    return classifyKeyCheckError(e, "Google Gemini", TEST_MODEL);
  }
}

// Catalog verified against ai.google.dev/gemini-api/docs/pricing on 2026-08-01.
// The app previously shipped Gemini 2.5 as "recommended" and 2.0 Flash Lite as
// "cheapest" — two generations behind, and 2.0 Flash Lite had been withdrawn
// from the API entirely, so selecting it produced a 404 on every call.
export const google: Provider = {
  id: "google",
  name: "Google Gemini",
  category: "freemium",
  description: "Strong at multimodal + long-context. Generous free tier across the Gemini 3 family.",
  free_note: "Free tier (AI Studio key): rate-limited but genuinely usable on the Flash + Flash-Lite models.",
  get_key_url: "https://aistudio.google.com/app/apikey",
  default_model: "gemini-3.6-flash",
  supports_vision: true,
  models: [
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash — recommended (free tier)", pricing: { input_per_million_usd: 1.5, output_per_million_usd: 7.5 }, context_k: 1000, best_for: "Default — newest Flash, free tier", supports_vision: true },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite — cheapest (free tier)", pricing: { input_per_million_usd: 0.3, output_per_million_usd: 2.5 }, best_for: "High-volume hashtags / subject lines", supports_vision: true },
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", pricing: { input_per_million_usd: 1.5, output_per_million_usd: 9 }, supports_vision: true },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite — budget", pricing: { input_per_million_usd: 0.25, output_per_million_usd: 1.5 }, supports_vision: true },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro — long-context (legacy)", pricing: { input_per_million_usd: 1.25, output_per_million_usd: 10 }, best_for: "Long teardowns", supports_vision: true },
    { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash (legacy)", pricing: { input_per_million_usd: 0.3, output_per_million_usd: 2.5 }, supports_vision: true },
  ],
  testKey,
  call,
  stream,
};
