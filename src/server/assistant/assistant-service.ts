import "server-only";

import { AIProviderError, type AIErrorKind } from "@/lib/ai/errors";
import { getAIProvider } from "@/lib/ai/provider";
import type {
  AIProvider,
  ChatIntent,
  ChatTurn,
  ResumeContext,
  ResumeTaskInput,
} from "@/lib/ai/types";
import type { ChatMessage } from "@/lib/chat/types";
import { conversationIdSchema } from "@/lib/chat/validation";
import { getDb } from "@/lib/db/client";
import { resumeContentSchema } from "@/lib/documents/resume-content";
import { AppError, ERROR_CODES, NotFoundError } from "@/lib/errors/app-error";
import { looksLikeFormatRequest, matchTemplateNames } from "@/lib/formatting/chat-request";
import { documentHeadings } from "@/lib/formatting/document-headings";
import {
  describeEdits,
  editableSections,
  parseStoredEdits,
  sectionPreviews,
} from "@/lib/formatting/edits";
import type { FormattingJobView } from "@/lib/formatting/types";
import { getStorageProvider } from "@/lib/storage/provider";
import type { StorageKey } from "@/lib/storage/types";
import { EXTRACTION_FAILURES, type ExtractionFailureCode } from "@/lib/resumes/types";
import { addAssistantMessage, replyConflict } from "@/server/chat/conversation-service";
import { logger } from "@/server/logger";
import { isExtractable } from "@/server/resumes/extraction-service";
import { templateContextFor } from "@/server/templates/template-service";

import { startChatFormatting } from "./chat-formatting";

/*
 * Assistant orchestration: conversation + attached resumes → AI provider →
 * ASSISTANT message. Provider-agnostic (talks only to the AIProvider
 * interface). Only structured ResumeContent is sent as context — never raw
 * files, storage keys or URLs. Prompts, resume data and replies are never logged.
 */

export interface AssistantDeps {
  getProvider: () => AIProvider;
  /** How long to wait for a just-attached resume that is still being extracted. */
  extractionWaitMs: number;
  /**
   * Starts formatting when the latest message asks for it, so the reply can
   * say what really happened. Omitted (tests): formatting is never started.
   */
  startFormatting?: typeof startChatFormatting;
}

const defaultDeps: AssistantDeps = {
  getProvider: getAIProvider,
  extractionWaitMs: 15_000,
  startFormatting: startChatFormatting,
};

const HISTORY_MESSAGES = 40;
const STARTED_HISTORY_MESSAGES = 0;
const EXTRACTION_POLL_MS = 1_000;

/** In-process guard against concurrent replies (single app instance; see README). */
const inFlight = new Set<string>();

const PUBLIC_AI_ERRORS: Record<AIErrorKind, { status: number; message: string }> = {
  timeout: { status: 504, message: "The assistant took too long to respond. Please try again." },
  rate_limited: {
    status: 429,
    message: "The assistant is busy right now. Please try again in a moment.",
  },
  auth: { status: 503, message: "The assistant is unavailable right now." },
  unavailable: {
    status: 503,
    message: "The assistant is unavailable right now. Please try again.",
  },
  bad_request: {
    status: 502,
    message: "The assistant couldn't process this request. Please try again.",
  },
  invalid_response: {
    status: 502,
    message: "The assistant returned an unexpected response. Please try again.",
  },
  content_filter: { status: 422, message: "The assistant can't help with that request." },
};

const attachmentSelect = {
  orderBy: { position: "asc" },
  select: {
    uploadedFile: {
      select: {
        id: true,
        originalFilename: true,
        mimeType: true,
        extraction: { select: { status: true, content: true, failureCode: true } },
      },
    },
  },
} as const;

async function loadConversation(userId: string, conversationId: string) {
  return getDb().conversation.findFirst({
    where: { id: conversationId, userId },
    select: {
      id: true,
      messages: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: HISTORY_MESSAGES + 1,
        select: { id: true, role: true, content: true, attachments: attachmentSelect },
      },
    },
  });
}

type LoadedConversation = NonNullable<Awaited<ReturnType<typeof loadConversation>>>;
type LoadedMessage = LoadedConversation["messages"][number];

function hasPendingExtraction(message: LoadedMessage): boolean {
  return message.attachments.some((a) => a.uploadedFile.extraction?.status === "PROCESSING");
}

function attachmentNames(message: LoadedMessage): string[] {
  return message.attachments.map((a) => a.uploadedFile.originalFilename);
}

/** Resumes attached anywhere in the loaded window, newest first. */
function collectResumes(messages: LoadedMessage[]): ResumeContext[] {
  const seen = new Set<string>();
  const resumes: ResumeContext[] = [];
  for (const message of messages) {
    for (const { uploadedFile: file } of message.attachments) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
      if (!isExtractable(file.mimeType)) {
        resumes.push({
          filename: file.originalFilename,
          content: null,
          note: "Images can't be read yet.",
        });
        continue;
      }
      const extraction = file.extraction;
      if (extraction?.status === "READY") {
        const parsed = resumeContentSchema.safeParse(extraction.content);
        resumes.push(
          parsed.success
            ? { filename: file.originalFilename, content: parsed.data }
            : {
                filename: file.originalFilename,
                content: null,
                note: "The extracted data is unavailable.",
              },
        );
      } else if (extraction?.status === "FAILED") {
        const code = (extraction.failureCode ?? "internal") as ExtractionFailureCode;
        resumes.push({
          filename: file.originalFilename,
          content: null,
          note: EXTRACTION_FAILURES[code] ?? EXTRACTION_FAILURES.internal,
        });
      } else {
        resumes.push({
          filename: file.originalFilename,
          content: null,
          note: "It is still being read.",
        });
      }
    }
  }
  return resumes;
}

function toTurn(message: LoadedMessage): ChatTurn | null {
  if (message.role === "SYSTEM") return null;
  const names = attachmentNames(message);
  const content = [message.content, names.length ? `[Attached: ${names.join(", ")}]` : ""]
    .filter(Boolean)
    .join("\n");
  return content ? { role: message.role === "USER" ? "user" : "assistant", content } : null;
}

function publicError(error: AIProviderError): AppError {
  const mapped = PUBLIC_AI_ERRORS[error.kind];
  return new AppError({
    code:
      error.kind === "rate_limited" ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.SERVICE_UNAVAILABLE,
    status: mapped.status,
    publicMessage: mapped.message,
    message: `AI provider error: ${error.kind}`,
  });
}

function logProviderError(error: AIProviderError, conversationId: string) {
  const context = { kind: error.kind, status: error.status, conversationId };
  if (error.kind === "auth" || error.kind === "bad_request") {
    logger.error("AI reply failed", undefined, context);
  } else {
    logger.warn("AI reply failed", context);
  }
}

const replyFailed = () =>
  new AppError({
    code: ERROR_CODES.INTERNAL,
    status: 500,
    publicMessage: "The assistant couldn't finish this reply. Please try again.",
  });

/** Internal stream events: errors keep the AppError so non-streaming callers can throw it. */
export type AssistantReplyEvent =
  | { type: "formatting"; job: FormattingJobView }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage | null }
  | { type: "error"; error: AppError };

export interface AssistantReplyStream {
  /**
   * The reply as it is written: "delta" events, then one "done" (the reply
   * was saved as a single ASSISTANT message) or "error" (nothing saved). Ends
   * silently, saving nothing, when the signal is aborted (Stop generating).
   */
  events: AsyncGenerator<AssistantReplyEvent, void, undefined>;
  /** Frees the per-conversation reply lock if `events` is never run. Safe to repeat. */
  release: () => void;
}

/** Recent messages the intent reader sees, and how long it may take before the wording rules decide. */
const INTENT_HISTORY_MESSAGES = 6;
const INTENT_TIMEOUT_MS = 15_000;
const INTENT_ATTEMPTS = 2;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** What the model writes, after a formatting start, when a message needs no words back. */
const NO_REPLY_MARKER = "[NO_REPLY]";

/** The newest resume already formatted in this chat (its template and the changes applied), if any. */
async function lastFormattedIn(
  userId: string,
  conversationId: string,
): Promise<{ template: string; changes: string[]; headings?: string[] } | null> {
  try {
    const job = await getDb().formattingJob.findFirst({
      where: { userId, conversationId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      select: {
        edits: true,
        clientTemplate: { select: { name: true } },
        document: { select: { storageKey: true } },
      },
    });
    if (!job?.clientTemplate) return null;
    let headings: string[] = [];
    if (job.document) {
      try {
        const bytes = await getStorageProvider().getObject(
          job.document.storageKey as StorageKey,
          MAX_DOCUMENT_BYTES,
        );
        headings = await documentHeadings(bytes);
      } catch {
        headings = []; // the reading goes on without them
      }
    }
    return {
      template: job.clientTemplate.name,
      changes: describeEdits(parseStoredEdits(job.edits)),
      ...(headings.length ? { headings } : {}),
    };
  } catch {
    return null;
  }
}

/** The account's first name, if it has one (for the occasional personal touch). */
async function firstNameOf(userId: string): Promise<string | null> {
  try {
    const user = await getDb().user.findUnique({ where: { id: userId }, select: { name: true } });
    const first = user?.name?.trim().split(/\s+/)[0] ?? "";
    // Only a plain name: nothing odd gets into the prompt.
    return /^[\p{L}][\p{L}'’.-]{0,29}$/u.test(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Starts the assistant's reply to the newest (USER) message of the user's own
 * conversation. Everything that can fail up front (not found, already
 * answered, a reply already running, AI not configured) throws a safe
 * AppError here, before any streaming starts.
 */
export async function startAssistantReply(
  userId: string,
  conversationId: unknown,
  signal: AbortSignal,
  deps: AssistantDeps = defaultDeps,
): Promise<AssistantReplyStream> {
  const parsedId = conversationIdSchema.safeParse(conversationId);
  if (!parsedId.success) throw new NotFoundError("Conversation not found.");
  const id = parsedId.data;

  let conversation = await loadConversation(userId, id);
  if (!conversation) throw new NotFoundError("Conversation not found.");
  const latestId = conversation.messages[0]?.id;
  if (!latestId || conversation.messages[0]!.role !== "USER") throw replyConflict();

  const lockKey = `${userId}:${id}`;
  if (inFlight.has(lockKey)) {
    throw new AppError({
      code: ERROR_CODES.CONFLICT,
      status: 409,
      publicMessage: "A reply is already being generated.",
    });
  }
  inFlight.add(lockKey);
  let released = false;
  const release = () => {
    // Once only: a later reply may already hold the lock for this conversation.
    if (released) return;
    released = true;
    inFlight.delete(lockKey);
  };

  let provider: AIProvider;
  let input: ResumeTaskInput;
  let formatting: ResumeTaskInput["formatting"];
  let formattingJob: FormattingJobView | null = null;
  let userFirstName: string | null = null;
  try {
    provider = deps.getProvider(); // 503 if AI is not configured
    userFirstName = await firstNameOf(userId);

    // A resume attached a moment ago may still be extracting; wait briefly.
    const deadline = Date.now() + deps.extractionWaitMs;
    while (
      conversation &&
      !signal.aborted &&
      hasPendingExtraction(conversation.messages[0]!) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, EXTRACTION_POLL_MS));
      conversation = await loadConversation(userId, id);
    }
    if (!conversation || conversation.messages[0]?.id !== latestId) throw replyConflict();

    const [latest, ...earlier] = conversation.messages as [LoadedMessage, ...LoadedMessage[]];
    const names = attachmentNames(latest);
    const templates = await templateContextFor(userId, id);

    // Does this message ask for formatting? The model reads it (any language,
    // typos, nicknames, a "yes" to an offer) and says which templates; if that
    // step is unavailable, plain wording rules decide instead. A request starts
    // the job now, and the reply model is told the outcome.
    const previousReply = earlier[0]?.role === "ASSISTANT" ? earlier[0].content : null;
    const attachedResumes = collectResumes(conversation.messages);
    let intent: ChatIntent | null = null;
    if (
      deps.startFormatting &&
      !signal.aborted &&
      templates.availableTemplates.length > 0 &&
      attachedResumes.length > 0
    ) {
      const intentInput = {
        instruction: latest.content,
        history: earlier
          .slice(0, INTENT_HISTORY_MESSAGES)
          .reverse()
          .map(toTurn)
          .filter((turn): turn is ChatTurn => turn !== null),
        availableTemplates: templates.availableTemplates,
        selectedTemplate: templates.selectedTemplate,
        hasResume: true,
        resumeSections: attachedResumes[0]?.content
          ? editableSections(attachedResumes[0].content)
          : [],
        sectionPreviews: attachedResumes[0]?.content
          ? sectionPreviews(attachedResumes[0].content)
          : [],
        lastFormatted: await lastFormattedIn(userId, id),
      };
      // A slow or failed reading is tried once more before the wording rules take over.
      for (let attempt = 1; attempt <= INTENT_ATTEMPTS && !intent && !signal.aborted; attempt++) {
        try {
          intent = await provider.classifyChatIntent(intentInput, {
            signal: AbortSignal.any([signal, AbortSignal.timeout(INTENT_TIMEOUT_MS)]),
          });
        } catch (error) {
          logger.warn("Reading the chat request failed", {
            attempt,
            error: error instanceof Error ? error.name : "unknown",
          });
        }
      }
    }
    const wantsFormatting =
      intent !== null
        ? intent.format || intent.edits.length > 0
        : looksLikeFormatRequest(latest.content, {
            previousReply,
            templateNames: templates.availableTemplates,
          });
    if (deps.startFormatting && !signal.aborted && wantsFormatting) {
      const known = new Set(templates.availableTemplates.map((name) => name.toLowerCase()));
      let named = (intent?.templates ?? []).filter((name) => known.has(name.trim().toLowerCase()));
      // Safety net: when the message itself names some of the templates the model
      // returned, only those are started — never one that came from older turns.
      const inMessage = matchTemplateNames(latest.content, templates.availableTemplates).map(
        (name) => name.toLowerCase(),
      );
      const mentioned = named.filter((name) => inMessage.includes(name.toLowerCase()));
      if (mentioned.length > 0) named = mentioned;
      const outcome: Awaited<ReturnType<typeof startChatFormatting>> =
        intent && intent.edits.length === 0 && intent.unmatchedSections.length > 0
          ? {
              status: "not_started",
              reason: `The resume has no section called ${intent.unmatchedSections.map((name) => `"${name}"`).join(", ")}. Its sections are: ${(attachedResumes[0]?.content ? editableSections(attachedResumes[0].content) : []).join(", ")}.`,
            }
          : intent && named.length === 0 && intent.unmatched.length > 0
            ? {
                status: "not_started",
                reason: `No client template matches ${intent.unmatched.map((name) => `"${name}"`).join(", ")}. The templates are: ${templates.availableTemplates.join(", ")}.`,
              }
            : await deps.startFormatting(
                userId,
                id,
                latest.content,
                previousReply,
                named.length > 0 ? named : undefined,
                intent && intent.edits.length > 0 ? intent.edits : undefined,
              );
      if (outcome.status === "started") formattingJob = outcome.job;
      formatting =
        outcome.status === "started"
          ? {
              status: "started",
              templateName:
                outcome.jobs
                  .map((started) => started.template?.name)
                  .filter(Boolean)
                  .join(", ") || null,
              resumeFilename: outcome.job.resume?.filename ?? null,
              changes: outcome.job.edits,
            }
          : outcome;
    }

    input = {
      instruction:
        [latest.content, names.length ? `(Attached: ${names.join(", ")})` : ""]
          .filter(Boolean)
          .join("\n") || "Please review the attached file.",
      // After a formatting start the reply is about this one message: the app's own
      // facts say what happened, and older assistant turns (which can hold mistakes the
      // model would repeat) stay out entirely.
      history: earlier
        .slice(0, formatting?.status === "started" ? STARTED_HISTORY_MESSAGES : HISTORY_MESSAGES)
        .reverse()
        .map(toTurn)
        .filter((turn): turn is ChatTurn => turn !== null),
      resumes: collectResumes(conversation.messages),
      ...templates,
      ...(userFirstName ? { userFirstName } : {}),
      ...(formatting ? { formatting } : {}),
    };
  } catch (error) {
    release();
    throw error;
  }

  async function* run(): AsyncGenerator<AssistantReplyEvent, void, undefined> {
    try {
      if (formattingJob) yield { type: "formatting", job: formattingJob };
      let text = "";
      // After a formatting start the model decides whether anything needs saying:
      // a bare command gets only the marker (and the progress card is the answer),
      // anything a person would answer gets a line. Marker text is never shown.
      let held = formattingJob ? "" : null;
      try {
        for await (const chunk of provider.streamResumeTask(input, { signal })) {
          if (signal.aborted) return;
          text += chunk;
          if (held === null) {
            yield { type: "delta", text: chunk };
            continue;
          }
          held += chunk;
          if (
            NO_REPLY_MARKER.startsWith(held.trimStart()) ||
            held.trimStart().startsWith(NO_REPLY_MARKER)
          ) {
            continue; // still possibly the marker
          }
          yield { type: "delta", text: held };
          held = null;
        }
        if (held !== null && held && !text.trim().startsWith(NO_REPLY_MARKER)) {
          yield { type: "delta", text: held };
        }
      } catch (error) {
        if (signal.aborted) return; // stopped by the user: nothing is saved
        if (error instanceof AIProviderError) {
          logProviderError(error, id);
          yield { type: "error", error: publicError(error) };
        } else {
          logger.error("AI reply stream failed", error, { conversationId: id });
          yield { type: "error", error: replyFailed() };
        }
        return;
      }
      if (signal.aborted) return;

      const content = text.trim();
      if (formattingJob && content.startsWith(NO_REPLY_MARKER)) {
        // Nothing to say: the progress card is the answer, and no text is saved.
        yield { type: "done", message: null };
        return;
      }
      if (!content) {
        yield { type: "error", error: publicError(new AIProviderError("invalid_response", "")) };
        return;
      }
      try {
        // The only write: the finished reply, once (re-checks it still answers the newest message).
        yield { type: "done", message: await addAssistantMessage(userId, id, latestId!, content) };
      } catch (error) {
        if (!(error instanceof AppError))
          logger.error("Saving AI reply failed", error, { conversationId: id });
        yield { type: "error", error: error instanceof AppError ? error : replyFailed() };
      }
    } finally {
      release();
    }
  }

  return { events: run(), release };
}

/**
 * Generates and stores the whole reply without streaming (same path as the
 * stream; used by scripts and tests). Throws safe AppErrors; nothing is stored on failure.
 */
export async function generateAssistantReply(
  userId: string,
  conversationId: unknown,
  deps: AssistantDeps = defaultDeps,
): Promise<ChatMessage | null> {
  const reply = await startAssistantReply(
    userId,
    conversationId,
    new AbortController().signal,
    deps,
  );
  for await (const event of reply.events) {
    if (event.type === "done") return event.message;
    if (event.type === "error") throw event.error;
  }
  throw replyFailed();
}
