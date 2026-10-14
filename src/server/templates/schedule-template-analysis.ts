import "server-only";

import { after } from "next/server";

import { backgroundWork } from "@/server/jobs/work-limiter";
import { logger } from "@/server/logger";

import { runTemplateAnalysis } from "./template-service";

/**
 * Runs a claimed template analysis after the response (Next.js `after`). In-
 * process, no durable queue: a restart can leave a claim PROCESSING, which
 * becomes retryable after STALE_TEMPLATE_PROCESSING_MS.
 */
export function scheduleTemplateAnalysis(userId: string, templateId: string): void {
  after(async () => {
    try {
      await backgroundWork.run(() => runTemplateAnalysis(userId, templateId));
    } catch (error) {
      logger.error("Scheduled template analysis crashed", error, { templateId });
    }
  });
}
