/**
 * Normalizer tests.
 *
 * These guard the crash class that took out /history and the dashboard: an
 * imported backup whose ad rows were missing `cost_usd` / `usage_*` reached a
 * render site that called `.toFixed(4)` on undefined. importAll() used to
 * bulkPut ad/campaign/template/checklist rows raw — only brains were
 * normalized — so any older or hand-edited export was a white screen with no
 * recovery path short of wiping IndexedDB.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeAd,
  normalizeCampaign,
  normalizeTemplate,
  normalizeChecklistState,
  normalizeCustomItem,
} from "../normalize";

describe("normalizeAd", () => {
  it("fills every numeric field so render sites can call .toFixed()", () => {
    const ad = normalizeAd({ id: "a1", title: "Old export" });
    expect(ad.cost_usd).toBe(0);
    expect(ad.usage_input_tokens).toBe(0);
    expect(ad.usage_output_tokens).toBe(0);
    expect(() => ad.cost_usd.toFixed(4)).not.toThrow();
    expect(() => ad.usage_input_tokens.toLocaleString()).not.toThrow();
  });

  it("coerces non-finite numbers to 0 rather than propagating NaN", () => {
    const ad = normalizeAd({ cost_usd: "not a number", usage_input_tokens: NaN, usage_output_tokens: Infinity });
    expect(ad.cost_usd).toBe(0);
    expect(ad.usage_input_tokens).toBe(0);
    expect(ad.usage_output_tokens).toBe(0);
  });

  it("preserves valid values untouched", () => {
    const ad = normalizeAd({
      id: "keep-me",
      brand_id: "b1",
      platform: "google",
      campaign_type: "Search",
      title: "Real ad",
      output_text: "hello",
      model_id: "claude-sonnet-5",
      usage_input_tokens: 120,
      usage_output_tokens: 340,
      cost_usd: 0.0042,
      starred: true,
      status: "winner",
      notes: "n",
      created_at: 1700000000000,
    });
    expect(ad.id).toBe("keep-me");
    expect(ad.platform).toBe("google");
    expect(ad.status).toBe("winner");
    expect(ad.starred).toBe(true);
    expect(ad.cost_usd).toBeCloseTo(0.0042);
    expect(ad.created_at).toBe(1700000000000);
  });

  it("falls back to a safe platform/status for unknown enum values", () => {
    const ad = normalizeAd({ platform: "myspace", status: "exploded" });
    expect(ad.platform).toBe("meta");
    expect(ad.status).toBe("draft");
  });

  it("mints an id when one is missing", () => {
    expect(normalizeAd({}).id).toMatch(/[0-9a-f-]{36}/);
  });

  it("survives null / undefined input", () => {
    expect(() => normalizeAd(null)).not.toThrow();
    expect(() => normalizeAd(undefined)).not.toThrow();
    expect(normalizeAd(null).title).toBe("(untitled)");
  });

  it("keeps performance data but repairs its timestamp", () => {
    const ad = normalizeAd({ performance: { clicks: 10 } });
    expect(ad.performance?.clicks).toBe(10);
    expect(Number.isFinite(ad.performance!.updated_at)).toBe(true);
  });

  it("omits optional fields when absent rather than writing undefined", () => {
    const ad = normalizeAd({ id: "x" });
    expect("deleted_at" in ad).toBe(false);
    expect("campaign_id" in ad).toBe(false);
    expect("performance" in ad).toBe(false);
  });
});

describe("normalizeCampaign", () => {
  it("defaults status and name", () => {
    const c = normalizeCampaign({});
    expect(c.status).toBe("planning");
    expect(c.name).toBe("(untitled campaign)");
    expect(Number.isFinite(c.created_at)).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(normalizeCampaign({ status: "zombie" }).status).toBe("planning");
  });
});

describe("normalizeTemplate", () => {
  it("always yields an object input", () => {
    expect(normalizeTemplate({ input: "not an object" }).input).toEqual({});
    expect(normalizeTemplate({ input: { a: 1 } }).input).toEqual({ a: 1 });
  });
});

describe("normalizeChecklistState", () => {
  it("clamps streak to a non-negative integer", () => {
    expect(normalizeChecklistState({ streak: -5 }).streak).toBe(0);
    expect(normalizeChecklistState({ streak: 3.7 }).streak).toBe(3);
    expect(normalizeChecklistState({ streak: "nope" }).streak).toBe(0);
  });

  it("keeps last_completed null rather than coercing to 0", () => {
    // 0 would read as "completed at the epoch", which makes the streak logic
    // think the period is stale instead of never-started.
    expect(normalizeChecklistState({ last_completed: null }).last_completed).toBeNull();
    expect(normalizeChecklistState({}).last_completed).toBeNull();
    expect(normalizeChecklistState({ last_completed: 123 }).last_completed).toBe(123);
  });

  it("falls back to the daily scope for garbage", () => {
    expect(normalizeChecklistState({ scope: "hourly" }).scope).toBe("daily");
  });
});

describe("normalizeCustomItem", () => {
  it("coerces text and section to strings", () => {
    const c = normalizeCustomItem({ text: 42, section: null });
    expect(c.text).toBe("");
    expect(c.section).toBe("");
  });
});
