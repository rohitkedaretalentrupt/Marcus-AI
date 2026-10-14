import { useEffect, useState } from "react";

import type { ExtractionStatus } from "@/lib/resumes/types";

import { getExtraction } from "@/features/files/lib/file-api";

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes, then stop (a reload shows the final state)

/** Follows a file's resume extraction while it is PROCESSING. */
export function useExtractionStatus(fileId: string, initial: ExtractionStatus | null) {
  const [status, setStatus] = useState(initial);

  useEffect(() => {
    if (status !== "PROCESSING") return;
    let cancelled = false;
    let polls = 0;
    const timer = setInterval(async () => {
      polls += 1;
      if (polls >= MAX_POLLS) clearInterval(timer);
      try {
        const extraction = await getExtraction(fileId);
        if (!cancelled && extraction.status !== "PROCESSING") setStatus(extraction.status);
      } catch {
        // Transient errors: keep polling until the limit.
      }
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fileId, status]);

  return status;
}
