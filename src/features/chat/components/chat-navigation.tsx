"use client";

import { createContext, useContext } from "react";

export interface ChatNavigation {
  openNavigation: () => void;
  closeNavigation: () => void;
}

export const ChatNavigationContext = createContext<ChatNavigation | null>(null);

/** Opens/closes the mobile conversation drawer (no-ops visually on desktop). */
export function useChatNavigation(): ChatNavigation {
  const context = useContext(ChatNavigationContext);
  if (!context) throw new Error("useChatNavigation must be used inside <ChatShell>");
  return context;
}
