-- CreateEnum
CREATE TYPE "FormattingJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "formatting_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeFileId" TEXT,
    "clientTemplateId" TEXT,
    "status" "FormattingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "activeKey" TEXT,
    "plan" JSONB,
    "warnings" JSONB,
    "failureCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "engineVersion" INTEGER NOT NULL,
    "aiModel" TEXT,
    "resumeParserVersion" INTEGER,
    "resumeExtractedAt" TIMESTAMP(3),
    "templateAnalyzedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "formatting_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "generated_documents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "formattingJobId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "filename" VARCHAR(255) NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generated_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "formatting_jobs_activeKey_key" ON "formatting_jobs"("activeKey");

-- CreateIndex
CREATE INDEX "formatting_jobs_userId_createdAt_idx" ON "formatting_jobs"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "generated_documents_formattingJobId_key" ON "generated_documents"("formattingJobId");

-- CreateIndex
CREATE UNIQUE INDEX "generated_documents_storageKey_key" ON "generated_documents"("storageKey");

-- CreateIndex
CREATE INDEX "generated_documents_userId_idx" ON "generated_documents"("userId");

-- AddForeignKey
ALTER TABLE "formatting_jobs" ADD CONSTRAINT "formatting_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "formatting_jobs" ADD CONSTRAINT "formatting_jobs_resumeFileId_fkey" FOREIGN KEY ("resumeFileId") REFERENCES "uploaded_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "formatting_jobs" ADD CONSTRAINT "formatting_jobs_clientTemplateId_fkey" FOREIGN KEY ("clientTemplateId") REFERENCES "client_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generated_documents" ADD CONSTRAINT "generated_documents_formattingJobId_fkey" FOREIGN KEY ("formattingJobId") REFERENCES "formatting_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
