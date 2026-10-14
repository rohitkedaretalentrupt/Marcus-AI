"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { NEW_CHAT_PATH } from "@/lib/chat/routes";

import { deleteConversation } from "../lib/chat-api";

interface DeleteConversationDialogProps {
  conversationId: string;
  /** Leave the page after deleting (true when the deleted chat is the one open). */
  navigateAway?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function DeleteConversationDialog({
  conversationId,
  navigateAway = true,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: DeleteConversationDialogProps) {
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (deleting) return;
    setError(null);
    onOpenChange(next);
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await deleteConversation(conversationId);
      if (navigateAway) router.replace(NEW_CHAT_PATH);
      else onOpenChange(false);
      router.refresh();
    } catch {
      setError("Couldn't delete this conversation. Try again.");
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            This will permanently delete this conversation and its messages.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={deleting}>
              Cancel
            </Button>
          </AlertDialogCancel>
          {/* Not AlertDialogAction: that would close the dialog before the request finishes. */}
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
