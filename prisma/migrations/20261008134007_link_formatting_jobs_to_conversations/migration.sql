-- AlterTable
ALTER TABLE "formatting_jobs" ADD COLUMN     "conversationId" TEXT;

-- CreateIndex
CREATE INDEX "formatting_jobs_conversationId_createdAt_idx" ON "formatting_jobs"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "formatting_jobs" ADD CONSTRAINT "formatting_jobs_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
