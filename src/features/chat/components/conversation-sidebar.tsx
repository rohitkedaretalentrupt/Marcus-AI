"use client";

import { LayoutTemplate, SquarePen } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { Wordmark } from "@/components/layout/brand-link";
import { siteConfig } from "@/lib/config/site";
import { NEW_CHAT_PATH } from "@/lib/chat/routes";
import { TEMPLATES_PATH } from "@/lib/templates/routes";
import { UserMenu } from "@/features/auth/components/user-menu";

import { useChatNavigation } from "./chat-navigation";

/** Shared by the desktop sidebar and the mobile drawer. */
export function ConversationSidebar({ conversationList }: { conversationList: ReactNode }) {
  const { closeNavigation } = useChatNavigation();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center px-4 pr-14 md:pr-4">
        <span className="min-w-0 overflow-hidden">
          <Wordmark />
          <span className="sr-only">{siteConfig.name}</span>
        </span>
      </div>

      <div className="px-3 pb-2">
        <Link
          href={NEW_CHAT_PATH}
          onClick={closeNavigation}
          aria-label="New chat"
          className="flex min-h-11 w-full items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-10"
        >
          <SquarePen className="size-4" aria-hidden="true" />
          New chat
        </Link>
      </div>

      <nav aria-label="Conversation history" className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {conversationList}
      </nav>

      <div className="shrink-0 border-t p-2">
        <Link
          href={TEMPLATES_PATH}
          onClick={closeNavigation}
          className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-9"
        >
          <LayoutTemplate className="size-4 text-muted-foreground" aria-hidden="true" />
          Client templates
        </Link>
        <UserMenu variant="sidebar" />
      </div>
    </div>
  );
}
