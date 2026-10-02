/**
 * Per-provider free-tier quotas — what limits the user is likely hitting.
 * Reference text shown alongside the provider in Settings + StatusBar tooltip.
 *
 * These are documented public limits as of late 2025. They change; we update
 * when users report mismatch with reality. Not enforced client-side — the
 * provider returns 429 when exceeded; this is just *informational*.
 */

export interface FreeTier {
  /** Requests per minute on the free tier. null = not published / not capped. */
  rpm: number | null;
  /** Requests per DAY on the free tier. null = not published / not capped. */
  rpd: number | null;
  /** True when a payment card is required before any usage. */
  needs_card: boolean;
  /** Anything that makes the headline number misleading on its own. */
  caveat?: string;
}

export interface ProviderLimits {
  providerId: string;
  /** Concise one-line summary. Shown inline next to the model picker. */
  summary: string;
  /** Detailed bullets for tooltips / docs links. */
  details: string[];
  /** Whether the provider offers a free tier at all. */
  has_free_tier: boolean;
  /**
   * Structured limits, so the provider comparison can be built from DATA rather
   * than parsed out of the prose above. Single source of truth — quota-tracker
   * reads these too rather than keeping its own copy.
   */
  free_tier: FreeTier;
  /** Public docs URL where the user can confirm current limits. */
  docs_url: string;
}

export const PROVIDER_LIMITS: Record<string, ProviderLimits> = {
  anthropic: {
    providerId: "anthropic",
    summary: "Paid only — no free tier. $5 minimum top-up, $0/mo if unused.",
    details: [
      "Pay-as-you-go, no monthly minimum after first $5 top-up.",
      "Default tier-1 limits: 50 req/min, 40k input tokens/min for Sonnet.",
      "Higher tiers unlock automatically based on spend history.",
    ],
    has_free_tier: false,
    free_tier: { rpm: 50, rpd: null, needs_card: true },
    docs_url: "https://docs.anthropic.com/en/api/rate-limits",
  },
  openai: {
    providerId: "openai",
    summary: "Paid only — $5 minimum top-up. No free tier.",
    details: [
      "Tier-1 (≥$5 paid, <7 days old): 500 req/min for GPT-4.1 / GPT-5.",
      "Limits scale with billing history — tier-5 is 10,000 req/min.",
      "GPT-4.1-mini: cheapest paid tier, ~$0.40/M input.",
    ],
    has_free_tier: false,
    free_tier: { rpm: 500, rpd: null, needs_card: true },
    docs_url: "https://platform.openai.com/docs/guides/rate-limits",
  },
  google: {
    summary: "FREE tier · no card · but the daily cap is per-model and can be low.",
    providerId: "google",
    details: [
      // Corrected 2026-08-01 from a live 429: the blanket "1500 RPD" figure was
      // wrong for the newer models. Google returned
      // "limit: 20, model: gemini-3.6-flash" for free-tier requests.
      "Free daily caps are PER MODEL and vary a lot — gemini-3.6-flash is ~20 req/day.",
      "Flash-Lite models have much higher free caps — prefer them for volume.",
      "429 'quota exceeded' = day or minute cap. Look at the retry-in seconds.",
      "Paid tier (with billing): 2000 RPM, no daily cap, 4M TPM.",
    ],
    has_free_tier: true,
    free_tier: {
      rpm: 15,
      rpd: 20,
      needs_card: false,
      // Measured against the live API on 2026-08-01: the quota error names
      // "generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash".
      caveat: "Free limits are PER MODEL. gemini-3.6-flash allows only ~20 requests/day free; the Flash-Lite models are far more generous.",
    },
    docs_url: "https://ai.google.dev/gemini-api/docs/rate-limits",
  },
  groq: {
    providerId: "groq",
    summary: "FREE · 30 req/min · 14,400 req/day · 6,000 tokens/min.",
    details: [
      "Free tier: 30 RPM, ~14,400 RPD, 6,000 TPM on the larger models.",
      "The 20B models have higher TPM (30,000) for short tasks.",
      "Hard quota — exhaust the daily cap and you wait until midnight UTC.",
    ],
    has_free_tier: true,
    free_tier: { rpm: 30, rpd: 14400, needs_card: false },
    docs_url: "https://console.groq.com/docs/rate-limits",
  },
  cerebras: {
    providerId: "cerebras",
    summary: "FREE · 30 req/min · 60,000 tokens/min.",
    details: [
      "Free tier: 30 RPM, 60,000 TPM.",
      "Fastest tokens-per-second on the market (specialized hardware).",
      "Daily-token limits not publicly published — refresh on rate-limit error.",
    ],
    has_free_tier: true,
    free_tier: { rpm: 30, rpd: null, needs_card: false, caveat: "Daily token cap is not published — expect throttling on heavy use." },
    docs_url: "https://inference-docs.cerebras.ai/introduction",
  },
  openrouter: {
    providerId: "openrouter",
    summary: "FREE models · 20 req/min · 50/day on most :free variants.",
    details: [
      "Models tagged ':free' (Gemma 4, Nemotron 3): 20 RPM, 50 RPD.",
      "Free-tier accounts may face additional caps based on credit balance.",
      "Paid usage routes via your OpenRouter credit — buy credits separately.",
    ],
    has_free_tier: true,
    free_tier: { rpm: 20, rpd: 50, needs_card: false, caveat: "Applies to :free models only. Paid models draw on your OpenRouter credit." },
    docs_url: "https://openrouter.ai/docs/api-reference/limits",
  },
  together: {
    providerId: "together",
    summary: "Paid pay-as-you-go · select free models w/ daily quotas.",
    details: [
      "Most models pay-per-token. Cheap rates (~$0.15/M for GPT-OSS 120B).",
      "A handful of 'free' models have daily quotas — check the model card.",
      "$5 free signup credit; expires.",
    ],
    has_free_tier: false,
    free_tier: { rpm: null, rpd: null, needs_card: true, caveat: "Signup credit only, not an ongoing free tier." },
    docs_url: "https://docs.together.ai/docs/rate-limits",
  },
  deepseek: {
    providerId: "deepseek",
    summary: "Paid pay-as-you-go · cheapest serious reasoning model.",
    details: [
      "DeepSeek V4 Flash: ~$0.14/M input, ~$0.28/M output. No free tier.",
      "DeepSeek V4 Pro: ~$0.44/M input, ~$0.87/M output.",
      "Default RPM: tier-based, ~60 RPM for new accounts.",
    ],
    has_free_tier: false,
    free_tier: { rpm: 60, rpd: null, needs_card: true },
    docs_url: "https://api-docs.deepseek.com/quick_start/rate_limit",
  },
  mistral: {
    providerId: "mistral",
    summary: "Paid pay-as-you-go · €5 free credit on signup.",
    details: [
      "Mistral Large: ~$2/M input, $6/M output.",
      "Mistral Small: ~$0.20/M input, $0.60/M output — recommended cost/quality.",
      "Default 60 RPM; multilingual + JSON output is a strength.",
    ],
    has_free_tier: false,
    free_tier: { rpm: 60, rpd: null, needs_card: true, caveat: "Free signup credit, then pay-as-you-go." },
    docs_url: "https://docs.mistral.ai/deployment/laplateforme/tier/",
  },
};

export function getProviderLimits(providerId: string | null | undefined): ProviderLimits | null {
  if (!providerId) return null;
  return PROVIDER_LIMITS[providerId] ?? null;
}

/**
 * Free-tier request caps for the StatusBar's usage meter.
 *
 * Single source of truth — quota-tracker.ts used to keep its own hardcoded copy
 * of these numbers "to avoid an import cycle" (there is no cycle; this module
 * imports nothing). The copies had already drifted apart.
 */
export function getProviderLimitCaps(providerId: string): { rpm: number | null; rpd: number | null } {
  const t = PROVIDER_LIMITS[providerId]?.free_tier;
  return { rpm: t?.rpm ?? null, rpd: t?.rpd ?? null };
}
