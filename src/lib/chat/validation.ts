import { z } from "zod";

import { attachmentFileIdsSchema } from "@/lib/files/validation";
import { idSchema } from "@/lib/validation/common";

/** Long enough for pasted resume sections plus detailed instructions. */
export const MESSAGE_MAX_LENGTH = 20_000;
export const TITLE_MAX_LENGTH = 100;
export const DEFAULT_CONVERSATION_TITLE = "New conversation";

export const conversationIdSchema = idSchema;

/**
 * Normalises line endings and drops leading blank lines and trailing
 * whitespace only. Indentation, blank lines between paragraphs and spacing
 * inside the text are preserved exactly.
 */
export function normalizeMessageContent(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

export const messageContentSchema = z
  .string({ error: "Enter a message." })
  .transform(normalizeMessageContent)
  .pipe(
    z
      .string()
      .min(1, "Enter a message.")
      .max(MESSAGE_MAX_LENGTH, `Messages can be at most ${MESSAGE_MAX_LENGTH} characters.`),
  );

export const conversationTitleSchema = z
  .string({ error: "Enter a title." })
  .trim()
  .min(1, "Enter a title.")
  .max(TITLE_MAX_LENGTH, `Titles can be at most ${TITLE_MAX_LENGTH} characters.`);

/** Like messageContentSchema but may be empty (a message can be attachments only). */
const optionalContentSchema = z
  .string({ error: "Enter a message." })
  .transform(normalizeMessageContent)
  .pipe(
    z.string().max(MESSAGE_MAX_LENGTH, `Messages can be at most ${MESSAGE_MAX_LENGTH} characters.`),
  );

const hasTextOrAttachments = (data: { content: string; attachmentFileIds: string[] }) =>
  data.content.length > 0 || data.attachmentFileIds.length > 0;

// Strict objects: unknown keys (e.g. a client-supplied `userId`) are rejected,
// so request bodies can never smuggle extra fields into a database write.

/**
 * `message` / `attachmentFileIds` optionally create the first user message in
 * the same request. Attachment ids are only references: ownership and upload
 * state are verified server-side.
 */
export const createConversationSchema = z.strictObject({
  message: optionalContentSchema.optional(),
  attachmentFileIds: attachmentFileIdsSchema.default([]),
});

export const renameConversationSchema = z.strictObject({
  title: conversationTitleSchema,
});

export const sendMessageSchema = z
  .strictObject({
    content: optionalContentSchema,
    attachmentFileIds: attachmentFileIdsSchema.default([]),
  })
  .refine(hasTextOrAttachments, { path: ["content"], message: "Enter a message." });

export const pinConversationSchema = z.strictObject({ pinned: z.boolean() });

export const messageIdSchema = idSchema;

/** Editing keeps the message's attachments; text may be empty only if it has some. */
export const editMessageSchema = z.strictObject({ content: optionalContentSchema });

export const conversationRouteParamsSchema = z.object({
  conversationId: conversationIdSchema,
});

export type CreateConversationInput = z.output<typeof createConversationSchema>;
export type RenameConversationInput = z.output<typeof renameConversationSchema>;
export type SendMessageInput = z.output<typeof sendMessageSchema>;
