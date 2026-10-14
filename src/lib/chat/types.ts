import type { FileSummary } from "@/lib/files/types";

/**
 * Wire/props shapes for chat. Isomorphic; dates are ISO strings so the same
 * objects work in JSON responses and server → client component props.
 */

export const MESSAGE_ROLES = ["USER", "ASSISTANT", "SYSTEM"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface ConversationSummary {
  id: string;
  title: string;
  /** Pinned chats are listed first. */
  pinned: boolean;
  createdAt: string;
  lastMessageAt: string;
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  /** May be empty when the message only carries attachments. */
  content: string;
  createdAt: string;
  /** In the order the user attached them. */
  attachments: FileSummary[];
}

export interface ConversationWithMessages extends ConversationSummary {
  messages: ChatMessage[];
  /** Client template selected for this conversation (used to preselect it on the Format page). */
  clientTemplate: { id: string; name: string } | null;
  /** True when older messages exist beyond the loaded window. */
  hasOlderMessages: boolean;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to load the next page; null when there is none. */
  nextCursor: string | null;
}
