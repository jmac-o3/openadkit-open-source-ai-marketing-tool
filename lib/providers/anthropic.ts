import { LLMError, SSE_EVENT_DELIMITER, classifyKeyCheckError, type KeyCheckResult, type LLMCallOptions, type LLMMessage, type LLMResult, type LLMUsage, type Provider, type StreamHandlers } from "./types";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

function headers(apiKey: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": API_VERSION,
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/** Models that removed `temperature` / `top_p` / `top_k` from the request
 *  surface — sending any of them returns HTTP 400. Covers the Claude 5 family
 *  and Opus 4.7+. Steer these with prompting instead. */
function rejectsSamplingParams(model: string): boolean {
  return /^claude-(opus-5|sonnet-5|fable-5|mythos-5|opus-4-(7|8))/.test(model);
}

/** Models where thinking is adaptive-by-default (Claude Opus 5) or opt-in.
 *  OpenAdKit generates short structured copy with `max_tokens` in the 2.5k–6k
 *  range, and `max_tokens` caps thinking + response text *together* — leaving
 *  adaptive thinking on would truncate the actual output mid-JSON. We disable
 *  it explicitly, which Opus 5 accepts at the default `high` effort. */
function supportsThinkingToggle(model: string): boolean {
  return /^claude-(opus-5|sonnet-5|opus-4-(7|8))/.test(model);
}

/** Build the `system` field. When caching is requested and the prompt is long
 *  enough to actually cache (the API silently no-ops below ~512-1024 tokens),
 *  emit the block form with a cache_control breakpoint. OpenAdKit's system
 *  prompt is the brand brain + framework stack — stable across every call for
 *  a given brand, so it's an ideal cache prefix. */
function buildSystem(opts: LLMCallOptions) {
  if (!opts.system) return undefined;
  // ~4 chars/token: only bother past ~600 tokens so we never pay the 1.25x
  // cache-write premium on a prefix too short to be cached.
  if (!opts.cacheSystem || opts.system.length < 2400) return opts.system;
  return [{ type: "text", text: opts.system, cache_control: { type: "ephemeral" } }];
}

function buildBody(opts: LLMCallOptions, stream: boolean) {
  const body: Record<string, unknown> = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 2048,
    system: buildSystem(opts),
    messages: toAnthropicMessages(opts.messages),
  };
  if (stream) body.stream = true;
  if (!rejectsSamplingParams(opts.model)) {
    body.temperature = opts.temperature ?? 0.7;
  }
  if (supportsThinkingToggle(opts.model)) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

/** Translate OpenAdKit's neutral LLMMessage[] into Anthropic's wire format,
 *  handling both plain text and multimodal (text + image) content. */
function toAnthropicMessages(messages: LLMMessage[]) {
  return messages.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: m.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : {
              type: "image",
              source: { type: "base64", media_type: part.media_type, data: part.data },
            }
      ),
    };
  });
}

async function readError(res: Response): Promise<LLMError> {
  // 429 Retry-After surfacing — Anthropic uses standard Retry-After plus the
  // `anthropic-ratelimit-*-reset` family. We pick whichever is shortest.
  // (Audit finding #61.)
  const ra = res.headers.get("retry-after");
  const retryPrefix = res.status === 429 && ra ? `Rate limit — retry in ${ra}s. ` : res.status === 429 ? "Rate limit hit. " : "";
  if (res.status === 429) {
    const seconds = Number(ra) || 60;
    try {
      const { recordRateLimitHit } = await import("../quota-tracker");
      recordRateLimitHit("anthropic", seconds);
    } catch {}
  }
  try {
    const body = await res.json();
    return new LLMError(retryPrefix + (body?.error?.message ?? res.statusText), res.status, "anthropic");
  } catch {
    return new LLMError(retryPrefix + res.statusText, res.status, "anthropic");
  }
}

async function call(opts: LLMCallOptions): Promise<LLMResult> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: headers(opts.apiKey),
    body: JSON.stringify(buildBody(opts, false)),
    signal: opts.signal,
  });
  if (!res.ok) throw await readError(res);
  const body = await res.json();
  const text = (body?.content ?? [])
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("");
  return { text, usage: body?.usage ?? null, modelId: opts.model };
}

async function stream(opts: LLMCallOptions, handlers: StreamHandlers): Promise<LLMResult> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: headers(opts.apiKey),
    body: JSON.stringify(buildBody(opts, true)),
    signal: opts.signal,
  });
  if (!res.ok) throw await readError(res);
  if (!res.body) throw new LLMError("Streaming response missing body", undefined, "anthropic");
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
      // Tolerate CRLF as well as LF — see SSE_EVENT_DELIMITER. Anthropic sends
      // LF today, but hardcoding that is what silently broke Gemini streaming.
      const events = buffer.split(SSE_EVENT_DELIMITER);
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const dataLines = ev.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
        for (const raw of dataLines) {
          const line = raw.trim();
          if (!line || line === "[DONE]") continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
              full += evt.delta.text;
              handlers.onDelta?.(evt.delta.text);
            } else if (evt.type === "message_delta" && evt.usage) {
              const merged: LLMUsage = { ...(usage ?? { input_tokens: 0, output_tokens: 0 }), ...evt.usage };
              usage = merged;
              handlers.onUsage?.(merged);
            } else if (evt.type === "message_start" && evt.message?.usage) {
              usage = evt.message.usage;
            } else if (evt.type === "error") {
              throw new LLMError(evt.error?.message ?? "stream error", undefined, "anthropic");
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

const TEST_MODEL = "claude-haiku-4-5"; // un-suffixed alias; cheapest model
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
    return classifyKeyCheckError(e, "Anthropic", TEST_MODEL);
  }
}

// Pricing is USD per million tokens, from platform.claude.com/docs/en/pricing.
// Reviewed 2026-08-01. lib/__tests__/providers-catalog.test.ts asserts the
// catalog stays internally consistent; re-check the published prices whenever
// a model is added (Opus 4.7 shipped listed at 15/75 here for months when the
// real rate was 5/25 — a 3x over-report on every cost estimate).
export const anthropic: Provider = {
  id: "anthropic",
  name: "Anthropic Claude",
  category: "paid",
  description: "The model OpenAdKit was originally built for. Strongest at long-context reasoning + safety. No free tier; pay-per-use.",
  get_key_url: "https://console.anthropic.com/settings/keys",
  default_model: "claude-sonnet-5",
  supports_vision: true,
  supports_prompt_caching: true,
  models: [
    { id: "claude-opus-5", label: "Opus 5 — deepest reasoning", pricing: { input_per_million_usd: 5, output_per_million_usd: 25 }, context_k: 1000, best_for: "Complex audits, multi-step reasoning, long teardowns", supports_vision: true },
    { id: "claude-sonnet-5", label: "Sonnet 5 — balanced (recommended)", pricing: { input_per_million_usd: 3, output_per_million_usd: 15 }, context_k: 1000, best_for: "Default for ad copy + optimization", supports_vision: true },
    { id: "claude-opus-4-7", label: "Opus 4.7 — previous flagship", pricing: { input_per_million_usd: 5, output_per_million_usd: 25 }, context_k: 1000, best_for: "Long-horizon agentic work", supports_vision: true },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — previous balanced", pricing: { input_per_million_usd: 3, output_per_million_usd: 15 }, context_k: 1000, supports_vision: true },
    { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest & cheapest", pricing: { input_per_million_usd: 1, output_per_million_usd: 5 }, context_k: 200, best_for: "High-volume hashtag/subject generation", supports_vision: true },
  ],
  testKey,
  call,
  stream,
};
