import { describe, it, expect } from "vitest";
import { budgetStatusFrom, currentPeriod, periodStart, BUDGET_WARN_AT } from "../budget";

const NOW = new Date(2026, 6, 15, 12, 0, 0); // 15 Jul 2026, local time
const thisMonth = (day: number) => new Date(2026, 6, day).getTime();
const lastMonth = (day: number) => new Date(2026, 5, day).getTime();

describe("budgetStatusFrom", () => {
  it("counts only spend inside the current calendar month", () => {
    const s = budgetStatusFrom(
      [
        { cost_usd: 5, created_at: thisMonth(2) },
        { cost_usd: 3, created_at: thisMonth(14) },
        // Last month's spend must not count against this month's budget.
        { cost_usd: 100, created_at: lastMonth(20) },
      ],
      { now: NOW, limitUsd: 20, hardStop: false }
    );
    expect(s.spentUsd).toBe(8);
    expect(s.remainingUsd).toBe(12);
  });

  it("reports no budget when the limit is 0", () => {
    const s = budgetStatusFrom([{ cost_usd: 999, created_at: thisMonth(1) }], {
      now: NOW,
      limitUsd: 0,
      hardStop: true,
    });
    expect(s.ratio).toBe(0);
    expect(s.warning).toBe(false);
    expect(s.exceeded).toBe(false);
    expect(s.blocked).toBe(false);
    expect(s.remainingUsd).toBe(Infinity);
  });

  it(`warns at ${BUDGET_WARN_AT * 100}% but does not block`, () => {
    const s = budgetStatusFrom([{ cost_usd: 8, created_at: thisMonth(3) }], {
      now: NOW,
      limitUsd: 10,
      hardStop: true,
    });
    expect(s.warning).toBe(true);
    expect(s.exceeded).toBe(false);
    expect(s.blocked).toBe(false);
  });

  it("marks exceeded at exactly 100%", () => {
    const s = budgetStatusFrom([{ cost_usd: 10, created_at: thisMonth(3) }], {
      now: NOW,
      limitUsd: 10,
      hardStop: false,
    });
    expect(s.exceeded).toBe(true);
    // Hard stop is off, so generation still proceeds — advisory by default.
    expect(s.blocked).toBe(false);
  });

  it("only blocks when the hard stop is enabled", () => {
    const over = [{ cost_usd: 12, created_at: thisMonth(3) }];
    expect(budgetStatusFrom(over, { now: NOW, limitUsd: 10, hardStop: false }).blocked).toBe(false);
    expect(budgetStatusFrom(over, { now: NOW, limitUsd: 10, hardStop: true }).blocked).toBe(true);
  });

  it("never reports negative remaining", () => {
    const s = budgetStatusFrom([{ cost_usd: 50, created_at: thisMonth(3) }], {
      now: NOW,
      limitUsd: 10,
      hardStop: false,
    });
    expect(s.remainingUsd).toBe(0);
  });

  it("ignores rows with missing or non-finite cost/date", () => {
    const s = budgetStatusFrom(
      [
        { cost_usd: 5, created_at: thisMonth(2) },
        { cost_usd: undefined, created_at: thisMonth(2) },
        { cost_usd: NaN, created_at: thisMonth(2) },
        { cost_usd: 5, created_at: undefined },
        {},
      ],
      { now: NOW, limitUsd: 20, hardStop: false }
    );
    expect(s.spentUsd).toBe(5);
    expect(Number.isFinite(s.spentUsd)).toBe(true);
  });

  it("treats an empty history as zero spend", () => {
    const s = budgetStatusFrom([], { now: NOW, limitUsd: 10, hardStop: true });
    expect(s.spentUsd).toBe(0);
    expect(s.blocked).toBe(false);
  });

  it("includes an ad created exactly at the period boundary", () => {
    const s = budgetStatusFrom([{ cost_usd: 4, created_at: periodStart(NOW) }], {
      now: NOW,
      limitUsd: 10,
      hardStop: false,
    });
    expect(s.spentUsd).toBe(4);
  });
});

describe("currentPeriod", () => {
  it("formats as YYYY-MM with a zero-padded month", () => {
    expect(currentPeriod(new Date(2026, 0, 5))).toBe("2026-01");
    expect(currentPeriod(new Date(2026, 11, 31))).toBe("2026-12");
  });
});
