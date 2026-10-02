import { describe, it, expect } from "vitest";
import { PROVIDER_LIMITS, getProviderLimits, getProviderLimitCaps } from "../provider-limits";
import { PROVIDERS } from "../providers";

/**
 * /providers renders this table as fact — published free-tier caps that users
 * decide where to spend money based on. Nothing here can validate the numbers
 * against the vendors (they change without notice), but it CAN stop the two
 * failure modes we've actually hit:
 *
 *   1. A provider added to PROVIDERS with no entry here → the comparison page
 *      silently shows "—" for a provider that may well have a free tier.
 *   2. has_free_tier disagreeing with free_tier — e.g. has_free_tier:false
 *      alongside rpd:14400, which would print "Paid only · 14,400/day".
 */
describe("provider-limits: coverage", () => {
  for (const p of PROVIDERS) {
    it(`${p.id} has a limits entry`, () => {
      const lim = getProviderLimits(p.id);
      expect(lim, `${p.id} is in PROVIDERS but missing from PROVIDER_LIMITS`).toBeTruthy();
      expect(lim!.free_tier, `${p.id} has no free_tier block`).toBeTruthy();
    });
  }

  it("has no limits entry for a provider that doesn't exist", () => {
    const known = new Set<string>(PROVIDERS.map((p) => p.id));
    for (const id of Object.keys(PROVIDER_LIMITS)) {
      expect(known.has(id), `PROVIDER_LIMITS has a stale entry for "${id}"`).toBe(true);
    }
  });
});

describe("provider-limits: free_tier is internally consistent", () => {
  for (const [id, lim] of Object.entries(PROVIDER_LIMITS)) {
    const ft = lim.free_tier;

    it(`${id}: a free daily cap implies has_free_tier`, () => {
      // A provider with an actual free request allowance must not be labelled
      // "Paid only" on the comparison page.
      if (ft.rpd != null && ft.rpd > 0) {
        expect(lim.has_free_tier, `${id} lists rpd=${ft.rpd} but has_free_tier is false`).toBe(true);
      }
    });

    it(`${id}: free tier requiring no card is actually free`, () => {
      if (ft.needs_card === false) {
        expect(lim.has_free_tier, `${id} needs no card but isn't marked as having a free tier`).toBe(true);
      }
    });

    it(`${id}: paid-only providers explain themselves`, () => {
      // "Paid only" with a signup credit is a meaningfully different offer from
      // "Paid only" flat — the caveat is what tells the user which they're seeing.
      if (!lim.has_free_tier) {
        expect(ft.rpd, `${id} is paid-only but claims a free daily cap`).toBeNull();
      }
    });

    it(`${id}: rate figures are positive finite numbers or null`, () => {
      for (const [field, v] of [["rpm", ft.rpm], ["rpd", ft.rpd]] as const) {
        if (v !== null) {
          expect(Number.isFinite(v), `${id}.${field} is not finite`).toBe(true);
          expect(v, `${id}.${field} must be > 0`).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe("getProviderLimitCaps", () => {
  it("mirrors the free_tier block it re-exports", () => {
    for (const [id, lim] of Object.entries(PROVIDER_LIMITS)) {
      expect(getProviderLimitCaps(id)).toEqual({ rpm: lim.free_tier.rpm, rpd: lim.free_tier.rpd });
    }
  });

  it("returns nulls for an unknown provider rather than throwing", () => {
    expect(getProviderLimitCaps("not-a-provider")).toEqual({ rpm: null, rpd: null });
  });

  it("still reports Google's measured daily cap, not the old 1,500 claim", () => {
    // A live 429 measured ~20/day on gemini-3.6-flash. This test exists because
    // a stale duplicate of this table claimed 1,500 and nobody noticed.
    const caps = getProviderLimitCaps("google");
    expect(caps.rpd).not.toBeNull();
    expect(caps.rpd!).toBeLessThan(100);
  });
});
