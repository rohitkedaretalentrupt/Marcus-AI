export const FORMATTING_JOBS_API = "/api/formatting-jobs";
export const formattingJobApi = (jobId: string) =>
  `${FORMATTING_JOBS_API}/${encodeURIComponent(jobId)}`;
