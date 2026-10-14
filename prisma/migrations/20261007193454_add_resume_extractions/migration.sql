-- CreateEnum
CREATE TYPE "ExtractionStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "resume_extractions" (
    "id" TEXT NOT NULL,
    "uploadedFileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ExtractionStatus" NOT NULL DEFAULT 'PROCESSING',
    "parserVersion" INTEGER NOT NULL,
    "rawText" TEXT,
    "content" JSONB,
    "warnings" JSONB,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_extractions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "resume_extractions_uploadedFileId_key" ON "resume_extractions"("uploadedFileId");

-- CreateIndex
CREATE INDEX "resume_extractions_userId_status_idx" ON "resume_extractions"("userId", "status");

-- AddForeignKey
ALTER TABLE "resume_extractions" ADD CONSTRAINT "resume_extractions_uploadedFileId_fkey" FOREIGN KEY ("uploadedFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_extractions" ADD CONSTRAINT "resume_extractions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
