-- CreateEnum
CREATE TYPE "FilePurpose" AS ENUM ('ATTACHMENT', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "clientTemplateId" TEXT;

-- AlterTable
ALTER TABLE "uploaded_files" ADD COLUMN     "purpose" "FilePurpose" NOT NULL DEFAULT 'ATTACHMENT';

-- CreateTable
CREATE TABLE "client_templates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "uploadedFileId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "nameKey" VARCHAR(100) NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PROCESSING',
    "structure" JSONB,
    "extractedText" TEXT,
    "analyzedBy" TEXT,
    "failureCode" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_templates_uploadedFileId_key" ON "client_templates"("uploadedFileId");

-- CreateIndex
CREATE INDEX "client_templates_userId_createdAt_idx" ON "client_templates"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "client_templates_userId_nameKey_key" ON "client_templates"("userId", "nameKey");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_clientTemplateId_fkey" FOREIGN KEY ("clientTemplateId") REFERENCES "client_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_templates" ADD CONSTRAINT "client_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_templates" ADD CONSTRAINT "client_templates_uploadedFileId_fkey" FOREIGN KEY ("uploadedFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
