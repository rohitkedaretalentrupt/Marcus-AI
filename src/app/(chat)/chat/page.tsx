import type { Metadata } from "next";

import { NewChatView } from "@/features/chat/components/new-chat-view";
import { isAIEnabled } from "@/lib/ai/provider";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "New chat",
};

export default async function NewChatPage() {
  await requireUser();
  return <NewChatView aiEnabled={isAIEnabled()} />;
}
