"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { hasAnyKeyConfigured } from "@/lib/settings";

/**
 * Blocks a route until at least one provider key is configured, bouncing to
 * /setup otherwise.
 *
 * Two things this deliberately does that the original didn't:
 *
 *  1. **Carries a return URL.** `/setup?next=/generate/meta` sends the user
 *     back to the tool they actually wanted instead of dumping them on the
 *     dashboard after onboarding.
 *
 *  2. **Re-checks on cross-tab changes.** `hasAnyKeyConfigured()` used to be
 *     read once on mount, so adding a key in a second tab left the first tab
 *     stuck on "Loading…" forever. We listen for `storage` (fires in *other*
 *     tabs) plus our own `ados:provider-changed` event.
 *
 * Pages that are useful without a key (Settings — where you go to ADD the key;
 * the checklists — which make no LLM calls at all) must not use this. Gating
 * Settings behind it created a genuine dead end: the StatusBar's "No key"
 * badge linked to /settings, which bounced straight back to /setup.
 */
export function ApiKeyGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  const check = useCallback(() => {
    if (hasAnyKeyConfigured()) {
      setReady(true);
      return;
    }
    setReady(false);
    // Read the location directly rather than via useSearchParams(): that hook
    // forces every page using this gate into client-side rendering (Next
    // errors out at build time without a Suspense boundary), and we only need
    // the value inside a browser-only effect anyway.
    const next =
      typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
    router.replace(`/setup?next=${encodeURIComponent(next || "/")}`);
  }, [router]);

  useEffect(() => {
    check();
    const onChange = () => check();
    window.addEventListener("storage", onChange);
    window.addEventListener("ados:provider-changed", onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener("ados:provider-changed", onChange);
    };
  }, [check]);

  if (!ready) {
    return (
      <div className="min-h-[60vh] grid place-items-center text-zinc-500 text-sm" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }
  return <>{children}</>;
}
