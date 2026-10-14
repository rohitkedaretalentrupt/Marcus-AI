import type { ConversationSummary } from "@/lib/chat/types";

export interface ConversationGroup {
  label: string;
  conversations: ConversationSummary[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * Pinned conversations come first in their own group; the rest are bucketed
 * (already sorted newest first) by the user's LOCAL calendar day of last activity. Must run in the browser — the server does
 * not know the user's time zone.
 */
export function groupConversationsByDate(
  conversations: readonly ConversationSummary[],
  now: Date = new Date(),
): ConversationGroup[] {
  const today = startOfLocalDay(now);
  const buckets: ConversationGroup[] = [
    { label: "Pinned", conversations: [] },
    { label: "Today", conversations: [] },
    { label: "Yesterday", conversations: [] },
    { label: "Previous 7 days", conversations: [] },
    { label: "Older", conversations: [] },
  ];

  for (const conversation of conversations) {
    if (conversation.pinned) {
      buckets[0]!.conversations.push(conversation);
      continue;
    }
    const day = startOfLocalDay(new Date(conversation.lastMessageAt));
    // Round: DST transitions make some days 23 or 25 hours long.
    const daysAgo = Math.round((today - day) / DAY_MS);
    const index = daysAgo <= 0 ? 1 : daysAgo === 1 ? 2 : daysAgo <= 7 ? 3 : 4;
    buckets[index]!.conversations.push(conversation);
  }

  return buckets.filter((bucket) => bucket.conversations.length > 0);
}
