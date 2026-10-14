import { describe, expect, it } from "vitest";

import type { ConversationSummary } from "@/lib/chat/types";

import { groupConversationsByDate } from "./group-conversations";

function conversation(id: string, lastMessageAt: Date, pinned = false): ConversationSummary {
  const iso = lastMessageAt.toISOString();
  return { id, title: id, pinned, createdAt: iso, lastMessageAt: iso };
}

// Local-time constructors keep the test independent of the machine's time zone.
const NOW = new Date(2026, 9, 7, 9, 30);

describe("groupConversationsByDate", () => {
  it("buckets by local calendar day and drops empty groups", () => {
    const groups = groupConversationsByDate(
      [
        conversation("today-early", new Date(2026, 9, 7, 0, 5)),
        conversation("yesterday-late", new Date(2026, 9, 6, 23, 55)),
        conversation("five-days", new Date(2026, 9, 2, 12, 0)),
        conversation("old", new Date(2026, 8, 1, 12, 0)),
      ],
      NOW,
    );

    expect(groups.map((g) => [g.label, g.conversations.map((c) => c.id)])).toEqual([
      ["Today", ["today-early"]],
      ["Yesterday", ["yesterday-late"]],
      ["Previous 7 days", ["five-days"]],
      ["Older", ["old"]],
    ]);
  });

  it("keeps the incoming (newest-first) order within a group", () => {
    const groups = groupConversationsByDate(
      [
        conversation("b", new Date(2026, 9, 7, 9, 0)),
        conversation("a", new Date(2026, 9, 7, 8, 0)),
      ],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.conversations.map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("returns no groups for no conversations", () => {
    expect(groupConversationsByDate([], NOW)).toEqual([]);
  });

  it("puts pinned conversations first, in their own group, whatever their date", () => {
    const groups = groupConversationsByDate(
      [
        conversation("pinned-old", new Date(2026, 1, 1, 12, 0), true),
        conversation("today", new Date(2026, 9, 7, 9, 0)),
        conversation("pinned-today", new Date(2026, 9, 7, 8, 0), true),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.conversations.map((c) => c.id)])).toEqual([
      ["Pinned", ["pinned-old", "pinned-today"]],
      ["Today", ["today"]],
    ]);
  });
});
