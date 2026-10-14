"use client";

import { EllipsisVertical, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { conversationPath } from "@/lib/chat/routes";
import type { ConversationSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils/cn";

import { useIsClient } from "../hooks/use-is-client";
import { setConversationPinned } from "../lib/chat-api";
import { groupConversationsByDate } from "../lib/group-conversations";
import { useChatNavigation } from "./chat-navigation";
import { DeleteConversationDialog } from "./delete-conversation-dialog";
import { RenameConversationDialog } from "./rename-conversation-dialog";

export function ConversationList({ conversations }: { conversations: ConversationSummary[] }) {
  const isClient = useIsClient();

  if (conversations.length === 0) {
    return <p className="px-2 py-3 text-sm text-muted-foreground">No conversations yet.</p>;
  }

  // Date headings depend on the browser's time zone, so they are added after
  // hydration; the server renders the same items without headings.
  const groups = isClient
    ? groupConversationsByDate(conversations)
    : [{ label: null, conversations }];

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <section key={group.label ?? "all"} aria-label={group.label ?? undefined}>
          {group.label ? (
            <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</h2>
          ) : null}
          <ul className="space-y-0.5">
            {group.conversations.map((conversation) => (
              <ConversationLink key={conversation.id} conversation={conversation} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ConversationLink({ conversation }: { conversation: ConversationSummary }) {
  const pathname = usePathname();
  const router = useRouter();
  const { closeNavigation } = useChatNavigation();
  const href = conversationPath(conversation.id);
  const isActive = pathname === href;
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pinError, setPinError] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  async function togglePin() {
    setPinError(false);
    try {
      await setConversationPinned(conversation.id, !conversation.pinned);
      router.refresh();
    } catch {
      setPinError(true);
    }
  }

  // The menu item that opened a dialog is gone when it closes; return focus to the ⋮ button.
  function restoreFocus(event: Event) {
    event.preventDefault();
    triggerRef.current?.focus();
  }

  return (
    <li className="group/item relative">
      <Link
        href={href}
        onClick={closeNavigation}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "flex min-h-11 items-center gap-1.5 rounded-md py-1 pr-11 pl-2 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-9 md:pr-9",
          isActive ? "bg-accent font-medium text-accent-foreground" : "hover:bg-accent/60",
        )}
      >
        {conversation.pinned ? (
          <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />
        ) : null}
        <span className="truncate">{conversation.title}</span>
      </Link>

      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label={`Options for ${conversation.title}`}
          className={cn(
            "absolute top-1/2 right-0.5 inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:size-8",
            // Touch screens: always visible. Mouse: on hover/focus, or while this chat is open.
            "md:opacity-0 md:group-hover/item:opacity-100 md:focus-visible:opacity-100 md:data-[state=open]:opacity-100",
            isActive && "md:opacity-100",
          )}
        >
          <EllipsisVertical className="size-4" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onSelect={() => void togglePin()}>
            {conversation.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
            {conversation.pinned ? "Unpin" : "Pin"}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {pinError ? (
        <p role="alert" className="px-2 text-xs text-destructive">
          Couldn&apos;t update this chat. Try again.
        </p>
      ) : null}

      <RenameConversationDialog
        conversationId={conversation.id}
        currentTitle={conversation.title}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onCloseAutoFocus={restoreFocus}
      />
      <DeleteConversationDialog
        conversationId={conversation.id}
        navigateAway={isActive}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onCloseAutoFocus={restoreFocus}
      />
    </li>
  );
}
