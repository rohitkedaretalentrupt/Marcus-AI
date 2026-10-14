-- DropForeignKey
ALTER TABLE "message_attachments" DROP CONSTRAINT "message_attachments_uploadedFileId_fkey";

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_uploadedFileId_fkey" FOREIGN KEY ("uploadedFileId") REFERENCES "uploaded_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;
