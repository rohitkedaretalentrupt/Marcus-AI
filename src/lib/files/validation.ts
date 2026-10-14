import { z } from "zod";

import { getFileExtension, sanitizeFilename } from "@/lib/utils/filename";
import { idSchema } from "@/lib/validation/common";

import { mimeTypeForExtension, SUPPORTED_MIME_TYPES } from "./file-types";
import { FILE_LIMITS, formatFileSize } from "./limits";

export const FILE_ERRORS = {
  tooLarge: `File is too large. Maximum size is ${formatFileSize(FILE_LIMITS.maxFileBytes)}.`,
  unsupported: "That file type isn't supported. Use PDF, DOCX, JPEG, PNG or WebP.",
  empty: "That file is empty.",
} as const;

export const fileIdSchema = idSchema;

/** Why a file is uploaded: chat attachment or client template source. */
export const FILE_PURPOSES = ["attachment", "template"] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * Metadata the browser sends when asking to upload. All of it is untrusted:
 * the declared type must agree with the extension, and the real size, type and
 * signature are verified against the stored object at confirmation.
 */
export const uploadRequestSchema = z
  .strictObject({
    filename: z.string().trim().min(1).max(255),
    contentType: z.enum(SUPPORTED_MIME_TYPES, { error: FILE_ERRORS.unsupported }),
    sizeBytes: z
      .number()
      .int()
      .min(1, FILE_ERRORS.empty)
      .max(FILE_LIMITS.maxFileBytes, FILE_ERRORS.tooLarge),
    purpose: z.enum(FILE_PURPOSES).default("attachment"),
  })
  .transform((input, ctx) => {
    const displayName = sanitizeFilename(input.filename);
    const extension = getFileExtension(displayName);
    if (!extension || mimeTypeForExtension(extension) !== input.contentType) {
      ctx.addIssue({ code: "custom", path: ["filename"], message: FILE_ERRORS.unsupported });
      return z.NEVER;
    }
    return { ...input, filename: displayName, extension };
  });

export type UploadRequest = z.output<typeof uploadRequestSchema>;

/** Attachments referenced by a message: unique ids, within the per-message limit. */
export const attachmentFileIdsSchema = z
  .array(fileIdSchema)
  .max(
    FILE_LIMITS.maxAttachmentsPerMessage,
    `You can attach up to ${FILE_LIMITS.maxAttachmentsPerMessage} files per message.`,
  )
  .refine((ids) => new Set(ids).size === ids.length, "Each file can only be attached once.");
