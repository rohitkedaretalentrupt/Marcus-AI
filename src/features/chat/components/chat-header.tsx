"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { ThemeToggle } from "@/components/theme-toggle";

import { useChatNavigation } from "./chat-navigation";

interface ChatHeaderProps {
  title: string;
  /** Secondary line, e.g. the selected client template. */
  subtitle?: string;
  actions?: ReactNode;
}

export function ChatHeader({ title, subtitle, actions }: ChatHeaderProps) {
  const { openNavigation } = useChatNavigation();

  return (
    <header className="shrink-0 border-b bg-background pt-safe">
      <div className="flex h-14 items-center gap-1 px-2 md:px-4">
        <button
          type="button"
          onClick={openNavigation}
          aria-label="Open conversations"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:hidden"
        >
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <h1 className="truncate text-base font-semibold">{title}</h1>
          {subtitle ? <p className="truncate text-xs text-muted-foreground">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center">{actions}</div> : null}
        {/* Light/dark switch: always the top-right corner. */}
        <ThemeToggle />
      </div>
    </header>
  );
}
