"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiRequestError } from "@/lib/api/client";
import { conversationTitleSchema, TITLE_MAX_LENGTH } from "@/lib/chat/validation";

import { renameConversation } from "../lib/chat-api";

interface RenameConversationDialogProps {
  conversationId: string;
  currentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

const FIELD_ID = "conversation-title";

export function RenameConversationDialog(props: RenameConversationDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent onCloseAutoFocus={props.onCloseAutoFocus}>
        {/* Remounted on every open, so the form always starts from the current title. */}
        {props.open ? <RenameForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ conversationId, currentTitle, onOpenChange }: RenameConversationDialogProps) {
  const router = useRouter();
  const [title, setTitle] = useState(currentTitle);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const parsed = conversationTitleSchema.safeParse(title);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a title.");
      return;
    }
    if (parsed.data === currentTitle) {
      onOpenChange(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await renameConversation(conversationId, parsed.data);
      router.refresh();
      onOpenChange(false);
    } catch (caught) {
      setError(
        caught instanceof ApiRequestError && caught.status === 400
          ? caught.displayMessage
          : "Couldn't rename this conversation. Try again.",
      );
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>Rename conversation</DialogTitle>
        <DialogDescription>Choose a name that&apos;s easy to find later.</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <Label htmlFor={FIELD_ID}>Title</Label>
        <Input
          id={FIELD_ID}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={TITLE_MAX_LENGTH}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${FIELD_ID}-error` : undefined}
          disabled={saving}
          autoFocus
        />
        {error ? (
          <p id={`${FIELD_ID}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline" disabled={saving}>
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={saving}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {saving ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  );
}
