import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { ConversationView } from "@/features/chat/components/conversation-view";
import { isAIEnabled } from "@/lib/ai/provider";
import { requireUser } from "@/lib/auth/session";
import { getConversation } from "@/server/chat/conversation-service";
import { listConversationFormattingJobs } from "@/server/formatting/formatting-service";

interface ConversationPageProps {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Shared by the page and its metadata within one request (one query). */
const loadConversation = cache(async (conversationId: string) => {
  const user = await requireUser();
  // Scoped to the session user: someone else's id is indistinguishable from a missing one.
  return getConversation(user.id, conversationId);
});

export async function generateMetadata({ params }: ConversationPageProps): Promise<Metadata> {
  const conversation = await loadConversation((await params).conversationId);
  return { title: conversation?.title ?? "Conversation not found" };
}

export default async function ConversationPage({ params, searchParams }: ConversationPageProps) {
  const conversation = await loadConversation((await params).conversationId);
  if (!conversation) notFound();
  const query = await searchParams;
  const user = await requireUser();
  const formattingJobs = await listConversationFormattingJobs(user.id, conversation.id);

  // Keyed so drafts and unsent messages never carry over between conversations.
  return (
    <ConversationView
      key={conversation.id}
      conversation={conversation}
      aiEnabled={isAIEnabled()}
      autoReply={query.respond === "1"}
      formattingJobs={formattingJobs}
      autoFormat={query.format === "1"}
    />
  );
}
