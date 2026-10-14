import "server-only";

import { deriveConversationTitle } from "@/lib/chat/title";
import type {
  ChatMessage,
  ConversationSummary,
  ConversationWithMessages,
  Page,
} from "@/lib/chat/types";
import {
  conversationIdSchema,
  createConversationSchema,
  DEFAULT_CONVERSATION_TITLE,
  editMessageSchema,
  messageIdSchema,
  pinConversationSchema,
  renameConversationSchema,
  sendMessageSchema,
} from "@/lib/chat/validation";
import { getDb } from "@/lib/db/client";
import { AppError, ERROR_CODES, NotFoundError, ValidationError } from "@/lib/errors/app-error";
import { FILE_LIMITS, formatFileSize } from "@/lib/files/limits";
import { USABLE_FILE_STATUSES } from "@/lib/files/types";
import { parseOrThrow } from "@/lib/validation/zod-issues";
import { Prisma } from "@/generated/prisma/client";
import { fileSummarySelect, toFileSummary } from "@/server/files/file-summary";

/*
 * Conversation and message persistence.
 *
 * SECURITY: every function takes the user id from the authenticated session
 * as its first argument, and every query filters on BOTH the record id and
 * that user id — ownership is enforced by the query itself, never by loading a
 * row and comparing its userId afterwards. Messages are only ever reached
 * through an owned conversation; attachments only through files owned by the
 * same user. "Not yours" and "does not exist" are indistinguishable.
 *
 * This module knows nothing about AI providers or object storage.
 */

const DEFAULT_CONVERSATION_PAGE_SIZE = 50;
const MAX_CONVERSATION_PAGE_SIZE = 100;
/** Most recent messages loaded when opening a conversation. */
export const MESSAGE_WINDOW_SIZE = 200;

const UNAVAILABLE_ATTACHMENTS =
  "One or more attachments are unavailable. Remove them and try again.";

const conversationSelect = {
  id: true,
  title: true,
  createdAt: true,
  lastMessageAt: true,
  pinnedAt: true,
} as const;

const messageSelect = {
  id: true,
  role: true,
  content: true,
  createdAt: true,
  attachments: {
    orderBy: { position: "asc" },
    select: { uploadedFile: { select: fileSummarySelect } },
  },
} as const satisfies Prisma.MessageSelect;

type Tx = Prisma.TransactionClient;
type ConversationRow = {
  id: string;
  title: string;
  createdAt: Date;
  lastMessageAt: Date;
  pinnedAt: Date | null;
};
type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

function toSummary(row: ConversationRow): ConversationSummary {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinnedAt !== null,
    createdAt: row.createdAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
  };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    attachments: row.attachments.map((attachment) => toFileSummary(attachment.uploadedFile)),
  };
}

function conversationNotFound(): NotFoundError {
  return new NotFoundError("Conversation not found.");
}

function attachmentError(message = UNAVAILABLE_ATTACHMENTS): ValidationError {
  return new ValidationError([{ path: "attachmentFileIds", message }], message);
}

/** Malformed ids are treated exactly like unknown ones. */
function parseConversationId(conversationId: unknown): string | null {
  const result = conversationIdSchema.safeParse(conversationId);
  return result.success ? result.data : null;
}

/**
 * Verifies that every referenced file belongs to the user, has been verified
 * after upload, is not already attached elsewhere, and that the combined size
 * is within the limit. Returns the files in the order given.
 */
async function resolveAttachments(tx: Tx, userId: string, fileIds: readonly string[]) {
  if (fileIds.length === 0) return [];

  const files = await tx.uploadedFile.findMany({
    where: {
      id: { in: [...fileIds] },
      userId,
      status: { in: [...USABLE_FILE_STATUSES] },
      purpose: "ATTACHMENT", // template source files are never attached to messages
      attachment: null,
    },
    select: { id: true, originalFilename: true, sizeBytes: true },
  });
  if (files.length !== fileIds.length) throw attachmentError();

  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (totalBytes > FILE_LIMITS.maxTotalAttachmentBytes) {
    throw attachmentError(
      `Attachments can total at most ${formatFileSize(FILE_LIMITS.maxTotalAttachmentBytes)} per message.`,
    );
  }

  const byId = new Map(files.map((file) => [file.id, file]));
  return fileIds.map((id) => byId.get(id)!);
}

function attachmentCreates(fileIds: readonly string[]) {
  return fileIds.map((uploadedFileId, position) => ({ uploadedFileId, position }));
}

/** A concurrent send that attached the same file loses on the unique index. */
async function withAttachmentRace<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw attachmentError();
    }
    throw error;
  }
}

/** The user's conversations, most recently active first (metadata only, no messages). */
export async function listConversations(
  userId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<Page<ConversationSummary>> {
  const limit = Math.min(
    Math.max(options.limit ?? DEFAULT_CONVERSATION_PAGE_SIZE, 1),
    MAX_CONVERSATION_PAGE_SIZE,
  );
  const cursor = options.cursor ? parseConversationId(options.cursor) : null;

  const rows = await getDb().conversation.findMany({
    where: { userId },
    // Pinned first (newest pin first), then by latest activity.
    orderBy: [
      { pinnedAt: { sort: "desc", nulls: "last" } },
      { lastMessageAt: "desc" },
      { id: "desc" },
    ],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: conversationSelect,
  });

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toSummary);
  return { items, nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null };
}

/**
 * Creates a conversation, optionally with its first user message and
 * attachments (atomic). The title comes from the message text, else from the
 * first attachment's name, else the default.
 */
export async function createConversation(
  userId: string,
  input: unknown,
): Promise<{ conversation: ConversationSummary; message: ChatMessage | null }> {
  const { message = "", attachmentFileIds } = parseOrThrow(createConversationSchema, input);
  const hasFirstMessage = message.length > 0 || attachmentFileIds.length > 0;

  const row = await withAttachmentRace(() =>
    getDb().$transaction(async (tx) => {
      const files = await resolveAttachments(tx, userId, attachmentFileIds);
      const title = message
        ? deriveConversationTitle(message)
        : files[0]
          ? deriveConversationTitle(files[0].originalFilename)
          : DEFAULT_CONVERSATION_TITLE;

      return tx.conversation.create({
        data: {
          userId,
          title,
          ...(hasFirstMessage
            ? {
                messages: {
                  create: {
                    role: "USER",
                    content: message,
                    attachments: { create: attachmentCreates(attachmentFileIds) },
                  },
                },
              }
            : {}),
        },
        select: { ...conversationSelect, messages: { select: messageSelect } },
      });
    }),
  );

  const { messages, ...conversation } = row;
  const first = messages[0];
  return { conversation: toSummary(conversation), message: first ? toMessage(first) : null };
}

/** The conversation with its most recent messages (oldest first), or null if not owned. */
export async function getConversation(
  userId: string,
  conversationId: unknown,
): Promise<ConversationWithMessages | null> {
  const id = parseConversationId(conversationId);
  if (!id) return null;

  const row = await getDb().conversation.findFirst({
    where: { id, userId },
    select: {
      ...conversationSelect,
      clientTemplate: { select: { id: true, name: true } },
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: MESSAGE_WINDOW_SIZE + 1,
        select: messageSelect,
      },
    },
  });
  if (!row) return null;

  const { messages, clientTemplate, ...conversation } = row;
  const hasOlderMessages = messages.length > MESSAGE_WINDOW_SIZE;
  return {
    ...toSummary(conversation),
    messages: messages.slice(0, MESSAGE_WINDOW_SIZE).reverse().map(toMessage),
    hasOlderMessages,
    clientTemplate,
  };
}

export async function renameConversation(
  userId: string,
  conversationId: unknown,
  input: unknown,
): Promise<ConversationSummary> {
  const id = parseConversationId(conversationId);
  if (!id) throw conversationNotFound();
  const { title } = parseOrThrow(renameConversationSchema, input);

  const db = getDb();
  // Explicit data object: only the title can ever be changed here.
  const { count } = await db.conversation.updateMany({ where: { id, userId }, data: { title } });
  if (count === 0) throw conversationNotFound();

  const row = await db.conversation.findFirst({
    where: { id, userId },
    select: conversationSelect,
  });
  if (!row) throw conversationNotFound();
  return toSummary(row);
}

/**
 * Deletes the conversation. Messages and attachment links go with it (ON
 * DELETE CASCADE); the files those links pointed to are marked DELETED and
 * returned so the caller can remove their stored objects.
 */
export async function deleteConversation(
  userId: string,
  conversationId: unknown,
): Promise<{ discardedFileIds: string[] }> {
  const id = parseConversationId(conversationId);
  if (!id) throw conversationNotFound();

  return getDb().$transaction(async (tx) => {
    const attachments = await tx.messageAttachment.findMany({
      where: { message: { conversation: { id, userId } } },
      select: { uploadedFileId: true },
    });

    const { count } = await tx.conversation.deleteMany({ where: { id, userId } });
    if (count === 0) throw conversationNotFound();

    const discardedFileIds = attachments.map((attachment) => attachment.uploadedFileId);
    if (discardedFileIds.length > 0) {
      await tx.uploadedFile.updateMany({
        where: { id: { in: discardedFileIds }, userId },
        data: { status: "DELETED" },
      });
    }
    return { discardedFileIds };
  });
}

/** Stores a USER message (text and/or attachments) in an owned conversation. */
export async function sendUserMessage(
  userId: string,
  conversationId: unknown,
  input: unknown,
): Promise<ChatMessage> {
  const id = parseConversationId(conversationId);
  if (!id) throw conversationNotFound();
  const { content, attachmentFileIds } = parseOrThrow(sendMessageSchema, input);

  return withAttachmentRace(() =>
    getDb().$transaction(async (tx) => {
      // The ownership check and the timestamp bump are a single statement.
      const { count } = await tx.conversation.updateMany({
        where: { id, userId },
        data: { lastMessageAt: new Date() },
      });
      if (count === 0) throw conversationNotFound();

      await resolveAttachments(tx, userId, attachmentFileIds);

      const row = await tx.message.create({
        data: {
          conversationId: id,
          role: "USER",
          content,
          attachments: { create: attachmentCreates(attachmentFileIds) },
        },
        select: messageSelect,
      });
      return toMessage(row);
    }),
  );
}

/**
 * Stores an ASSISTANT reply to `replyToMessageId`, which must still be the
 * newest message of the user's own conversation (prevents double replies when
 * two requests race). Used by the assistant orchestration; provider-agnostic.
 */
export async function addAssistantMessage(
  userId: string,
  conversationId: string,
  replyToMessageId: string,
  content: string,
): Promise<ChatMessage> {
  return getDb().$transaction(async (tx) => {
    const newest = await tx.message.findFirst({
      where: { conversation: { id: conversationId, userId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    });
    if (!newest) throw conversationNotFound();
    if (newest.id !== replyToMessageId) throw replyConflict();

    await tx.conversation.updateMany({
      where: { id: conversationId, userId },
      data: { lastMessageAt: new Date() },
    });
    const row = await tx.message.create({
      data: { conversationId, role: "ASSISTANT", content },
      select: messageSelect,
    });
    return toMessage(row);
  });
}

export function replyConflict(): AppError {
  return new AppError({
    code: ERROR_CODES.CONFLICT,
    status: 409,
    publicMessage: "This message has already been answered.",
  });
}

// --- pinning ------------------------------------------------------------------

/** Pins (`{ pinned: true }`) or unpins one of the user's conversations. */
export async function setConversationPinned(
  userId: string,
  conversationId: unknown,
  input: unknown,
): Promise<ConversationSummary> {
  const id = parseConversationId(conversationId);
  if (!id) throw conversationNotFound();
  const { pinned } = parseOrThrow(pinConversationSchema, input);
  const db = getDb();
  const { count } = await db.conversation.updateMany({
    where: { id, userId },
    data: { pinnedAt: pinned ? new Date() : null },
  });
  if (count === 0) throw conversationNotFound();
  const row = await db.conversation.findFirst({
    where: { id, userId },
    select: conversationSelect,
  });
  if (!row) throw conversationNotFound();
  return toSummary(row);
}

// --- message actions (edit / delete / retry) -------------------------------------

function messageNotFound(): NotFoundError {
  return new NotFoundError("Message not found.");
}

type MessageRef = { id: string; conversationId: string; createdAt: Date };

/** Messages that come after `message` in its conversation (same order as the chat). */
function laterThan(message: MessageRef): Prisma.MessageWhereInput {
  return {
    conversationId: message.conversationId,
    OR: [
      { createdAt: { gt: message.createdAt } },
      { createdAt: message.createdAt, id: { gt: message.id } },
    ],
  };
}

/**
 * Deletes the matching messages of an owned conversation. Their attachment
 * links go with them; the files are marked DELETED and returned so the
 * caller can remove the stored objects (as when a conversation is deleted).
 */
async function discardMessages(
  tx: Tx,
  userId: string,
  where: Prisma.MessageWhereInput,
): Promise<string[]> {
  const attachments = await tx.messageAttachment.findMany({
    where: { message: where },
    select: { uploadedFileId: true },
  });
  await tx.message.deleteMany({ where });
  const fileIds = attachments.map((attachment) => attachment.uploadedFileId);
  if (fileIds.length > 0) {
    await tx.uploadedFile.updateMany({
      where: { id: { in: fileIds }, userId },
      data: { status: "DELETED" },
    });
  }
  return fileIds;
}

async function findOwnedMessage(
  tx: Tx,
  userId: string,
  conversationId: unknown,
  messageId: unknown,
) {
  const conversation = parseConversationId(conversationId);
  const message = messageIdSchema.safeParse(messageId);
  if (!conversation || !message.success) throw messageNotFound();
  const row = await tx.message.findFirst({
    where: { id: message.data, conversationId: conversation, conversation: { userId } },
    select: {
      id: true,
      conversationId: true,
      createdAt: true,
      role: true,
      _count: { select: { attachments: true } },
    },
  });
  if (!row) throw messageNotFound();
  return row;
}

/**
 * Edits one of the user's own messages and removes everything after it (like
 * ChatGPT), so the conversation continues from the edited message. Its
 * attachments are kept.
 */
export async function editMessage(
  userId: string,
  conversationId: unknown,
  messageId: unknown,
  input: unknown,
): Promise<{ message: ChatMessage; discardedFileIds: string[] }> {
  const { content } = parseOrThrow(editMessageSchema, input);
  return getDb().$transaction(async (tx) => {
    const target = await findOwnedMessage(tx, userId, conversationId, messageId);
    if (target.role !== "USER") {
      const message = "Only your own messages can be edited.";
      throw new ValidationError([{ path: "messageId", message }], message);
    }
    if (!content && target._count.attachments === 0) {
      throw new ValidationError(
        [{ path: "content", message: "Enter a message." }],
        "Enter a message.",
      );
    }
    const discardedFileIds = await discardMessages(tx, userId, laterThan(target));
    const row = await tx.message.update({
      where: { id: target.id },
      data: { content },
      select: messageSelect,
    });
    await tx.conversation.updateMany({
      where: { id: target.conversationId, userId },
      data: { lastMessageAt: new Date() },
    });
    return { message: toMessage(row), discardedFileIds };
  });
}

/** Deletes a single message (and its attachments) from one of the user's conversations. */
export async function deleteMessage(
  userId: string,
  conversationId: unknown,
  messageId: unknown,
): Promise<{ discardedFileIds: string[] }> {
  return getDb().$transaction(async (tx) => {
    const target = await findOwnedMessage(tx, userId, conversationId, messageId);
    const discardedFileIds = await discardMessages(tx, userId, { id: target.id });
    return { discardedFileIds };
  });
}

/**
 * Prepares a retry. For a user message, everything after it is removed; for
 * an assistant reply, that reply and everything after it are removed. Returns
 * the user message to run again (its reply/formatting is then re-requested).
 */
export async function prepareRetry(
  userId: string,
  conversationId: unknown,
  messageId: unknown,
): Promise<{ message: ChatMessage; discardedFileIds: string[] }> {
  return getDb().$transaction(async (tx) => {
    const target = await findOwnedMessage(tx, userId, conversationId, messageId);
    let userMessage: MessageRef = target;
    let discardFrom: Prisma.MessageWhereInput = laterThan(target);

    if (target.role !== "USER") {
      const previous = await tx.message.findFirst({
        where: {
          conversationId: target.conversationId,
          role: "USER",
          OR: [
            { createdAt: { lt: target.createdAt } },
            { createdAt: target.createdAt, id: { lt: target.id } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, conversationId: true, createdAt: true },
      });
      if (!previous) {
        const message = "There is no message of yours to retry before this reply.";
        throw new ValidationError([{ path: "messageId", message }], message);
      }
      userMessage = previous;
      discardFrom = { OR: [{ id: target.id }, laterThan(target)] };
    }

    const discardedFileIds = await discardMessages(tx, userId, discardFrom);
    const row = await tx.message.findFirst({
      where: { id: userMessage.id, conversation: { userId } },
      select: messageSelect,
    });
    if (!row) throw messageNotFound();
    return { message: toMessage(row), discardedFileIds };
  });
}
