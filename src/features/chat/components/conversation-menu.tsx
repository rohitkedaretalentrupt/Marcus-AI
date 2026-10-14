"use client";

import { EllipsisVertical, LayoutTemplate, Pencil, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { SelectTemplateDialog } from "@/features/templates/components/select-template-dialog";

import { DeleteConversationDialog } from "./delete-conversation-dialog";
import { RenameConversationDialog } from "./rename-conversation-dialog";

interface ConversationMenuProps {
  conversationId: string;
  title: string;
  templateId: string | null;
}

export function ConversationMenu({ conversationId, title, templateId }: ConversationMenuProps) {
  const [templateOpen, setTemplateOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // The menu item that opened a dialog is gone when it closes; return focus to
  // the menu button instead of letting it fall back to <body>.
  function restoreFocus(event: Event) {
    event.preventDefault();
    triggerRef.current?.focus();
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={triggerRef}
          aria-label="Conversation options"
          className="inline-flex size-11 items-center justify-center rounded-md outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <EllipsisVertical className="size-5" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onSelect={() => setTemplateOpen(true)}>
            <LayoutTemplate aria-hidden="true" />
            Client template…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
            <Pencil aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Dialogs live outside the menu so closing the menu does not unmount them. */}
      <SelectTemplateDialog
        conversationId={conversationId}
        currentTemplateId={templateId}
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        onCloseAutoFocus={restoreFocus}
      />
      <RenameConversationDialog
        conversationId={conversationId}
        currentTitle={title}
        open={renameOpen}
        onOpenChange={setRenameOpen}
        onCloseAutoFocus={restoreFocus}
      />
      <DeleteConversationDialog
        conversationId={conversationId}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onCloseAutoFocus={restoreFocus}
      />
    </>
  );
}
