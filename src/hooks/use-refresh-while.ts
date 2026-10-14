"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While `active`, re-fetches the server-rendered page (e.g. to follow background processing). */
export function useRefreshWhile(active: boolean, intervalMs = 4000) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
}
