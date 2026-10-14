"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

import { useVisualViewportVariables } from "../hooks/use-visual-viewport";
import { ChatNavigationContext, type ChatNavigation } from "./chat-navigation";
import { ConversationSidebar } from "./conversation-sidebar";

interface ChatShellProps {
  /** Server-rendered conversation list (rendered in the sidebar and the mobile drawer). */
  conversationList: ReactNode;
  children: ReactNode;
}

/**
 * Full-screen chat frame. Desktop (md+): fixed-width sidebar + chat panel.
 * Mobile: the chat fills the screen and the conversation list lives in a
 * drawer opened from the header. Sized to the visual viewport so the composer
 * stays above the on-screen keyboard; only the message list scrolls.
 */
export function ChatShell({ conversationList, children }: ChatShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  useVisualViewportVariables();

  const navigation = useMemo<ChatNavigation>(
    () => ({
      openNavigation: () => setDrawerOpen(true),
      closeNavigation: () => setDrawerOpen(false),
    }),
    [],
  );

  return (
    <ChatNavigationContext.Provider value={navigation}>
      <div className="fixed inset-x-0 top-(--app-offset-top,0px) flex h-(--app-height,100dvh) overflow-hidden px-safe">
        <aside
          aria-label="Conversations"
          className="hidden w-72 shrink-0 flex-col border-r bg-muted/40 pt-safe pb-safe md:flex"
        >
          <ConversationSidebar conversationList={conversationList} />
        </aside>

        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent className="md:hidden">
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <SheetDescription className="sr-only">
              Start a new chat or open a previous conversation.
            </SheetDescription>
            <ConversationSidebar conversationList={conversationList} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </ChatNavigationContext.Provider>
  );
}
