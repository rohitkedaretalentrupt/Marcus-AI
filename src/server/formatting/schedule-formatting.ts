import "server-only";

import { after } from "next/server";

import { backgroundWork } from "@/server/jobs/work-limiter";
import { logger } from "@/server/logger";

import { runFormattingJob } from "./formatting-service";

/**
 * Runs a QUEUED formatting job after the response (Next.js `after`). In-
 * process, no durable queue: a restart can leave a job QUEUED or PROCESSING;
 * it becomes retryable after STALE_QUEUED_MS / STALE_PROCESSING_MS.
 */
export function scheduleFormattingJob(userId: string, jobId: string): void {
  after(async () => {
    try {
      await backgroundWork.run(() => runFormattingJob(userId, jobId));
    } catch (error) {
      logger.error("Scheduled formatting job crashed", error, { jobId });
    }
  });
}

/**
 * Starts a QUEUED formatting job right away, without waiting for the response
 * to finish — for a streamed chat reply, whose response lasts as long as the
 * reply. Same in-process caveats as scheduleFormattingJob.
 */
export function startFormattingJobNow(userId: string, jobId: string): void {
  backgroundWork
    .run(() => runFormattingJob(userId, jobId))
    .catch((error: unknown) => {
      logger.error("Formatting job crashed", error, { jobId });
    });
}
