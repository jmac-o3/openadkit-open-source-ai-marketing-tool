/**
 * Monthly spend budget.
 *
 * OpenAdKit already tracks per-client spend in History, but nothing stopped a
 * runaway loop (or an enthusiastic batch run across 40 clients on an expensive
 * model) from quietly burning through a month's API budget. This adds the
 * missing half: a ceiling, a warning band, and an enforcement point.
 *
 * Design notes:
 *  - Spend is derived from the ads table, NOT from the lifetime usage counters
 *    in localStorage. The counters are cumulative-since-reset and have no date
 *    dimension, so they can't answer "how much this calendar month".
 *  - "This month" is calendar-month in the user's LOCAL timezone, which is what
 *    a person means when they say "my March budget".
 *  - Enforcement is advisory-by-default (warn) and opt-in for the hard stop,
 *    because silently blocking generation would be worse than overspending for
 *    some users.
 */

const KEY_LIMIT = "ados.budget.monthly_usd";
const KEY_ENFORCE = "ados.budget.hard_stop";
const KEY_DISMISSED = "ados.budget.warn_dismissed_period";

/** Fraction of the limit at which we start warning. */
export const BUDGET_WARN_AT = 0.8;

function safeLocal(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Monthly limit in USD. 0 / unset means "no budget configured". */
export function getMonthlyBudgetUsd(): number {
  const raw = safeLocal()?.getItem(KEY_LIMIT);
  const n = Number(raw ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function setMonthlyBudgetUsd(v: number): void {
  const s = safeLocal();
  if (!s) return;
  if (!Number.isFinite(v) || v <= 0) s.removeItem(KEY_LIMIT);
  else s.setItem(KEY_LIMIT, String(v));
  window.dispatchEvent(new Event("ados:budget-changed"));
}

/** When true, generation is blocked once the budget is exhausted. */
export function isHardStopEnabled(): boolean {
  return safeLocal()?.getItem(KEY_ENFORCE) === "1";
}

export function setHardStopEnabled(v: boolean): void {
  const s = safeLocal();
  if (!s) return;
  if (v) s.setItem(KEY_ENFORCE, "1");
  else s.removeItem(KEY_ENFORCE);
  window.dispatchEvent(new Event("ados:budget-changed"));
}

/** `YYYY-MM` in local time — the period a budget applies to. */
export function currentPeriod(when = new Date()): string {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}`;
}

/** Start-of-month timestamp in local time. */
export function periodStart(when = new Date()): number {
  return new Date(when.getFullYear(), when.getMonth(), 1).getTime();
}

export interface BudgetStatus {
  /** Configured ceiling; 0 when no budget is set. */
  limitUsd: number;
  /** Spend so far this calendar month. */
  spentUsd: number;
  /** 0..1+ — can exceed 1 when over budget. 0 when no budget is set. */
  ratio: number;
  /** True once spend crosses BUDGET_WARN_AT of the limit. */
  warning: boolean;
  /** True once spend meets or exceeds the limit. */
  exceeded: boolean;
  /** True when generation should be refused (exceeded AND hard stop enabled). */
  blocked: boolean;
  remainingUsd: number;
}

/**
 * Compute status from a list of ads. Kept pure (takes the rows rather than
 * reading the DB) so it's unit-testable and so callers that already hold the
 * ads don't pay for a second query.
 */
export function budgetStatusFrom(
  ads: { cost_usd?: number; created_at?: number }[],
  opts?: { now?: Date; limitUsd?: number; hardStop?: boolean }
): BudgetStatus {
  const now = opts?.now ?? new Date();
  const limitUsd = opts?.limitUsd ?? getMonthlyBudgetUsd();
  const hardStop = opts?.hardStop ?? isHardStopEnabled();
  const start = periodStart(now);
  let spentUsd = 0;
  for (const a of ads) {
    const at = Number(a.created_at);
    const cost = Number(a.cost_usd);
    if (!Number.isFinite(at) || at < start) continue;
    if (Number.isFinite(cost)) spentUsd += cost;
  }
  const ratio = limitUsd > 0 ? spentUsd / limitUsd : 0;
  const exceeded = limitUsd > 0 && spentUsd >= limitUsd;
  return {
    limitUsd,
    spentUsd,
    ratio,
    warning: limitUsd > 0 && ratio >= BUDGET_WARN_AT,
    exceeded,
    blocked: exceeded && hardStop,
    remainingUsd: limitUsd > 0 ? Math.max(0, limitUsd - spentUsd) : Infinity,
  };
}

/** Read the ads table and compute this month's status. Browser-only. */
export async function getBudgetStatus(): Promise<BudgetStatus> {
  if (typeof window === "undefined") return budgetStatusFrom([], { limitUsd: 0 });
  const { listAds } = await import("./storage");
  const ads = await listAds();
  return budgetStatusFrom(ads);
}

/**
 * Throw when the hard stop is active. Call at the top of every generation
 * entry point. Returns the status so callers can also surface a warning.
 */
export class BudgetExceededError extends Error {
  constructor(public status: BudgetStatus) {
    super(
      `Monthly budget reached: $${status.spentUsd.toFixed(2)} of $${status.limitUsd.toFixed(2)}. ` +
        `Raise or clear the limit in Settings to keep generating.`
    );
    this.name = "BudgetExceededError";
  }
}

export async function assertWithinBudget(): Promise<BudgetStatus> {
  const status = await getBudgetStatus();
  if (status.blocked) throw new BudgetExceededError(status);
  return status;
}

/** The warning banner is dismissible per period, so it nags once a month, not
 *  once a page load. */
export function isWarningDismissed(period = currentPeriod()): boolean {
  return safeLocal()?.getItem(KEY_DISMISSED) === period;
}
export function dismissWarning(period = currentPeriod()): void {
  safeLocal()?.setItem(KEY_DISMISSED, period);
  window.dispatchEvent(new Event("ados:budget-changed"));
}
