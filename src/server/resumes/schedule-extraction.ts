import "server-only";

import { after } from "next/server";

import type { ResumeExtractionView } from "@/lib/resumes/types";
import { backgroundWork } from "@/server/jobs/work-limiter";
import { logger } from "@/server/logger";

import { runResumeExtraction, startResumeExtraction } from "./extraction-service";

/**
 * Claims the extraction now and performs it after the response has been sent
 * (Next.js `after`). This runs in the app process — there is no durable job
 * queue yet, so a server restart can leave a claim PROCESSING; it is treated as
 * stale after STALE_PROCESSING_MS and can be retried.
 */
export async function scheduleResumeExtraction(
  userId: string,
  fileId: string,
): Promise<ResumeExtractionView> {
  const claim = await startResumeExtraction(userId, fileId);
  after(async () => {
    try {
      await backgroundWork.run(() => runResumeExtraction(userId, fileId));
    } catch (error) {
      logger.error("Scheduled resume extraction crashed", error, { fileId });
    }
  });
  return claim;
}
