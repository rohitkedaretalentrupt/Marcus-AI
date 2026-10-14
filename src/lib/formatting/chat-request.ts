import { z } from "zod";

import { fileIdSchema } from "@/lib/files/validation";
import { idSchema } from "@/lib/validation/common";

/**
 * Formatting from the chat. A message such as "Format my resume using the
 * Client A template" starts a formatting job in that conversation (no AI
 * needed to recognise it). So do short follow-ups to a reply that offered
 * formatting ("yes", "do it for Zillow"), and short commands that name one of
 * the user's templates ("use Zillow").
 */

const FORMAT_WORDS = /\b(?:re-?)?format(?:s|ted|ting)?\b|\bapply\b[^.?!]*\btemplate\b/i;

/** A reply that offers or asks about formatting ("Want me to go ahead with Zillow instead?"). */
const OFFER_WORDS = /\b(?:format(?:ting)?|template|go ahead|proceed)\b/i;

/** Offers made without a question mark ("Want me to use that one instead, or …"). */
const OFFER_PHRASES =
  /\b(?:want me to|shall i|should i|would you like|do you want|just confirm|confirm and|say the word|let me know)\b/i;

/** Agreement or a go-ahead, as the whole short message ("yes", "ok do it", "go ahead please"). */
const AFFIRMATIVE =
  /^(?:(?:yes|yeah|yep|yup|sure|ok(?:ay)?|alright|please|pls|go ahead|go for it|do it|proceed|sounds good|let'?s do it|let'?s go|of course|absolutely|why not|that works|perfect|great)[\s,.!]*)+$/i;

/** A command that uses a template name ("do it for Zillow", "use Zillow", "Zillow please"). */
const ACTION_WORDS =
  /\b(?:please|pls|use|using|with|for|in|as per|per|apply|go with|try|do it|do|make it|convert|switch to|into)\b/i;

/** Longest follow-up still read as a command; longer messages need a format word. */
const MAX_FOLLOW_UP_CHARS = 80;

export interface FormatRequestContext {
  /** The assistant's previous reply, if any. */
  previousReply?: string | null;
  /** Names of the user's client templates. */
  templateNames?: readonly string[];
}

/** True when the assistant's reply ends by offering (or asking about) formatting. */
export function offersFormatting(reply: string | null | undefined): boolean {
  if (!reply) return false;
  const ending = reply.trim().slice(-300);
  return (ending.includes("?") || OFFER_PHRASES.test(ending)) && OFFER_WORDS.test(ending);
}

/** True when a chat message asks for the resume to be formatted. */
export function looksLikeFormatRequest(text: string, context: FormatRequestContext = {}): boolean {
  if (FORMAT_WORDS.test(text)) return true;
  const message = text.trim();
  if (!message || message.length > MAX_FOLLOW_UP_CHARS || message.endsWith("?")) return false;

  const namesTemplate = matchTemplateName(message, context.templateNames ?? []) !== null;
  if (offersFormatting(context.previousReply) && (AFFIRMATIVE.test(message) || namesTemplate)) {
    return true;
  }
  return namesTemplate && ACTION_WORDS.test(message);
}

/** "as per Abbott", "using the Abbott template", "into Abbott format" at the end of a message. */
const REQUESTED_NAME =
  /\b(?:as per|using|with|into|like)\s+(?:the\s+)?([a-z0-9][\w&.' -]{0,40}?)(?:\s+(?:template|format|layout|style|one))?\s*[.!]*$/i;

/** Words after "using …" etc. that are not a template name. */
const NOT_A_NAME =
  /^(?:it|this|that|these|those|them|me|my resume|my cv|the resume|resume|cv|my|a|an|the|template|format|layout|style|this one|that one|same|the same|selected|the selected|current|the current|default|word|docx|pdf|care|your help|help)$/i;

/**
 * The template name a message explicitly asks for ("format as per Abbott" →
 * "Abbott"), or null. Used to refuse unknown names instead of silently
 * falling back to another template.
 */
export function requestedTemplateName(text: string): string | null {
  const candidate = REQUESTED_NAME.exec(text.trim())?.[1]?.trim();
  return candidate && !NOT_A_NAME.test(candidate) ? candidate : null;
}

/** The longest template name mentioned in the text (case-insensitive), if any. */
export function matchTemplateName(text: string, names: readonly string[]): string | null {
  const haystack = text.toLowerCase();
  return (
    [...names]
      .filter((name) => name.trim() && haystack.includes(name.trim().toLowerCase()))
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

export const startChatFormattingSchema = z.strictObject({
  /** A resume attached in this conversation; default: the newest one. */
  resumeFileId: fileIdSchema.optional(),
  /** Default: a template named in `text`, else in `previousReply`, else the conversation's selected template. */
  templateId: idSchema.optional(),
  /** The user's message, when formatting was requested by typing. */
  text: z.string().max(4000).optional(),
  /** The assistant reply the message answers ("Want me to use Zillow?" → "yes"). */
  previousReply: z.string().max(20_000).optional(),
});
