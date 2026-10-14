"use client";

import {
  AlertCircle,
  Check,
  Copy,
  FileText,
  Loader2,
  Pencil,
  RotateCw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

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
import { MESSAGE_MAX_LENGTH } from "@/lib/chat/validation";
import type { FileSummary } from "@/lib/files/types";
import { cn } from "@/lib/utils/cn";

import type { DisplayMessage } from "../lib/display-message";
import { AttachmentChip } from "./attachment-chip";
import { LocalTime } from "./local-time";
import { MarkdownContent } from "./markdown-content";

/** Actions on a saved message (ChatGPT/Claude style). Each returns once the change is done. */
export interface MessageActions {
  onEdit: (messageId: string, content: string) => Promise<void>;
  onRetryTask: (messageId: string) => Promise<void>;
  onDelete: (messageId: string) => Promise<void>;
  /** Whether "Retry" can do anything for this message (e.g. AI or formatting available). */
  canRetry: (message: DisplayMessage) => boolean;
  /** Another action or reply is in progress: actions are disabled meanwhile. */
  busy: boolean;
}

interface MessageItemProps {
  message: DisplayMessage;
  onRetry?: (clientId: string) => void;
  onDiscard?: (clientId: string) => void;
  actions?: MessageActions;
}

/**
 * User messages are rendered as plain React text (never HTML), with
 * whitespace preserved and long words/URLs wrapped. Assistant replies are
 * Markdown rendered safely (see MarkdownContent).
 */
const CONTENT_CLASS = "whitespace-pre-wrap [overflow-wrap:anywhere]";

export function MessageItem({ message, onRetry, onDiscard, actions }: MessageItemProps) {
  if (message.role === "USER") {
    return (
      <UserMessage message={message} onRetry={onRetry} onDiscard={onDiscard} actions={actions} />
    );
  }
  if (message.role === "ASSISTANT") return <AssistantMessage message={message} actions={actions} />;
  return null; // SYSTEM messages are instructions for the model, not shown to users.
}

function UserMessage({ message, onRetry, onDiscard, actions }: MessageItemProps) {
  const failed = message.status === "failed";
  const { clientId } = message;
  const [editing, setEditing] = useState(false);
  const canAct = message.status === "sent" && actions;

  return (
    <li className="group flex flex-col items-end gap-1">
      <AttachmentList files={message.attachments} />
      {editing && canAct ? (
        <EditBox
          initial={message.content}
          allowEmpty={message.attachments.length > 0}
          onCancel={() => setEditing(false)}
          onSave={async (content) => {
            await actions.onEdit(message.id, content);
            setEditing(false);
          }}
        />
      ) : message.content ? (
        <div
          className={
            failed
              ? `max-w-[85%] rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-2.5 ${CONTENT_CLASS}`
              : `max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground ${CONTENT_CLASS} ${message.status === "sending" ? "opacity-70" : ""}`
          }
        >
          <span className="sr-only">You said: </span>
          {message.content}
        </div>
      ) : null}

      <div className="flex min-h-5 items-center gap-2 px-1 text-xs text-muted-foreground">
        {canAct && !editing ? (
          <ActionBar
            message={message}
            actions={actions}
            onEdit={() => setEditing(true)}
            align="end"
          />
        ) : null}
        {message.status === "sending" ? <span>Sending…</span> : null}
        {message.status === "sent" ? <LocalTime iso={message.createdAt} /> : null}
        {failed && clientId ? (
          <span
            role="alert"
            className="flex flex-wrap items-center justify-end gap-x-1 text-destructive"
          >
            <AlertCircle className="size-3.5" aria-hidden="true" />
            Message couldn&apos;t be sent.
            <Button
              variant="link"
              size="sm"
              className="h-auto min-h-0 px-1 py-0 text-xs"
              onClick={() => onRetry?.(clientId)}
            >
              Try again
            </Button>
            <Button
              variant="link"
              size="sm"
              className="h-auto min-h-0 px-1 py-0 text-xs text-muted-foreground"
              onClick={() => onDiscard?.(clientId)}
            >
              Discard
            </Button>
          </span>
        ) : null}
      </div>
    </li>
  );
}

function AssistantMessage({
  message,
  actions,
}: {
  message: DisplayMessage;
  actions?: MessageActions;
}) {
  return (
    <li className="group flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground"
      >
        <FileText className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <AttachmentList files={message.attachments} />
        <span className="sr-only">Assistant said: </span>
        <MarkdownContent text={message.content} />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LocalTime iso={message.createdAt} />
          {actions && message.status === "sent" ? (
            <ActionBar message={message} actions={actions} align="start" />
          ) : null}
        </div>
      </div>
    </li>
  );
}

// --- actions ---------------------------------------------------------------------

function IconAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-40 md:size-8"
    >
      {children}
    </button>
  );
}

/** Copy / Edit / Retry / Delete. Always visible on touch screens; on hover or focus with a mouse. */
function ActionBar({
  message,
  actions,
  onEdit,
  align,
}: {
  message: DisplayMessage;
  actions: MessageActions;
  onEdit?: () => void;
  align: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isUser = message.role === "USER";

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (e.g. insecure context): nothing to copy to.
    }
  }

  async function retry() {
    setRetrying(true);
    try {
      await actions.onRetryTask(message.id);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100",
        align === "end" ? "order-first" : "",
      )}
    >
      {message.content ? (
        <IconAction label={copied ? "Copied" : "Copy"} onClick={() => void copy()}>
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
        </IconAction>
      ) : null}
      {isUser && onEdit ? (
        <IconAction label="Edit" onClick={onEdit} disabled={actions.busy}>
          <Pencil className="size-4" aria-hidden="true" />
        </IconAction>
      ) : null}
      {actions.canRetry(message) ? (
        <IconAction
          label={isUser ? "Retry" : "Regenerate"}
          onClick={() => void retry()}
          disabled={actions.busy || retrying}
        >
          {retrying ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw className="size-4" aria-hidden="true" />
          )}
        </IconAction>
      ) : null}
      <IconAction label="Delete" onClick={() => setConfirmDelete(true)} disabled={actions.busy}>
        <Trash2 className="size-4" aria-hidden="true" />
      </IconAction>
      <DeleteMessageDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        onConfirm={() => actions.onDelete(message.id)}
      />
    </div>
  );
}

function DeleteMessageDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      setError("Couldn't delete this message. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => (deleting ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete message?</AlertDialogTitle>
          <AlertDialogDescription>
            This message and any files attached to it will be permanently deleted.
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
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
            {deleting ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Inline editor for a sent message: Save re-runs the conversation from here. */
function EditBox({
  initial,
  allowEmpty,
  onCancel,
  onSave,
}: {
  initial: string;
  allowEmpty: boolean;
  onCancel: () => void;
  onSave: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const canSave = !saving && (value.trim().length > 0 || allowEmpty) && value !== initial;

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
    } catch {
      setError("Couldn't save your edit. Try again.");
      setSaving(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") onCancel();
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void save();
  }

  return (
    <div className="w-full max-w-[85%] space-y-2 rounded-2xl border bg-background p-2">
      <textarea
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        maxLength={MESSAGE_MAX_LENGTH}
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        aria-label="Edit message"
        className="w-full resize-y bg-transparent px-2 py-1.5 leading-6 outline-none"
      />
      {error ? (
        <p role="alert" className="px-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p className="px-2 text-xs text-muted-foreground">
        Saving replaces the replies after this message.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void save()} disabled={!canSave}>
          {saving ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}

function AttachmentList({ files }: { files: FileSummary[] }) {
  if (files.length === 0) return null;
  return (
    <ul aria-label="Attachments" className="flex max-w-[85%] flex-wrap justify-end gap-2">
      {files.map((file) => (
        <li key={file.id} className="max-w-full">
          <AttachmentChip file={file} />
        </li>
      ))}
    </ul>
  );
}
