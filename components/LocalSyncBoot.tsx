"use client";

import { useEffect } from "react";
import { bootLocalSync } from "@/lib/local-sync";

export function LocalSyncBoot() {
  useEffect(() => {
    bootLocalSync().then((r) => {
      if (r.enabled) {
        console.log("[openadkit] local-sync enabled · pulled snapshot:", r.pulled);
      } else {
        console.log("[openadkit] local-sync sidecar not detected — running in browser-only mode");
      }
    });
  }, []);
  return null;
}
