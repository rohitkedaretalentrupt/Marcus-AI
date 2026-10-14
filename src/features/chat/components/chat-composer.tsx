"use client";

import { ArrowUp, Loader2, Mic, Paperclip, Square } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { MESSAGE_MAX_LENGTH } from "@/lib/chat/validation";
import { FILE_INPUT_ACCEPT } from "@/lib/files/file-types";
import type { FileSummary } from "@/lib/files/types";
import { cn } from "@/lib/utils/cn";

import { useAttachmentUploads } from "../hooks/use-attachment-uploads";
import { AttachmentTray } from "./attachment-tray";

const NOTICE_DURATION_MS = 4000;
const COUNTER_THRESHOLD = MESSAGE_MAX_LENGTH * 0.9;

/** Shown in place of a feature a later phase will implement — nothing is faked. */
const VOICE_UNAVAILABLE = "Voice input will be available soon.";

interface ChatComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * Called with the message text and the verified attachments. Return (or
   * resolve) true to clear the input; false keeps everything so the user can retry.
   */
  onSend: (content: string, attachments: FileSummary[]) => boolean | Promise<boolean>;
  disabled?: boolean;
  placeholder?: string;
  /** Lets the parent focus the input (e.g. after picking a suggestion). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Short note under the input (e.g. that AI replies are not connected yet). */
  footnote?: string;
  /** Extra buttons after the attach button (e.g. Format). */
  actions?: ReactNode;
  /** A reply is being generated: Send becomes "Stop generating" and sending waits. */
  generating?: boolean;
  onStop?: () => void;
}

/** Touch-first devices get Enter = newline; send with the button. */
function prefersNewlineOnEnter(): boolean {
  return window.matchMedia("(pointer: coarse)").matches;
}

export function ChatComposer({
  value,
  onValueChange,
  onSend,
  disabled = false,
  placeholder = "Message…",
  inputRef,
  footnote,
  actions,
  generating = false,
  onStop,
}: ChatComposerProps) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = inputRef ?? ownRef;
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hintId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachments = useAttachmentUploads();

  const hasContent = value.trim().length > 0 || attachments.items.length > 0;
  const canSend =
    hasContent &&
    !submitting &&
    !disabled &&
    !generating &&
    !attachments.isBusy &&
    !attachments.hasFailed;
  const blockedReason = attachments.isBusy
    ? "Waiting for attachments to finish uploading…"
    : attachments.hasFailed
      ? "Retry or remove failed attachments to send."
      : null;

  // Auto-grow with the content; CSS max-height caps it and enables scrolling.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [value, textareaRef]);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  function showNotice(message: string) {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_DURATION_MS);
  }

  async function submit() {
    if (!canSend) return;
    setSubmitting(true);
    try {
      if (await onSend(value, attachments.readyFiles)) {
        onValueChange("");
        attachments.clearSent();
      }
    } finally {
      setSubmitting(false);
      textareaRef.current?.focus();
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (prefersNewlineOnEnter()) return;
    event.preventDefault();
    void submit();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto w-full max-w-3xl px-3 pt-2 pb-[max(var(--safe-bottom),0.75rem)] md:px-4"
    >
      <div role="status" aria-live="polite" className="min-h-0">
        {notice || attachments.limitError ? (
          <p className="mb-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {attachments.limitError ?? notice}
          </p>
        ) : null}
      </div>

      {/* The real (visually hidden) picker; the paperclip button is its accessible control. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={FILE_INPUT_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
        onChange={(event) => {
          attachments.addFiles(Array.from(event.target.files ?? []));
          event.target.value = ""; // allow picking the same file again after removing it
        }}
      />

      <div
        className={cn(
          "rounded-2xl border bg-background p-1 shadow-xs transition-[box-shadow,border-color]",
          "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30",
          disabled && "opacity-60",
        )}
      >
        <AttachmentTray
          items={attachments.items}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
        />
        <div className="flex items-end gap-0.5">
          <ComposerIconButton
            label="Attach file"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
          >
            <Paperclip className="size-5" aria-hidden="true" />
          </ComposerIconButton>
          {actions}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            maxLength={MESSAGE_MAX_LENGTH}
            placeholder={placeholder}
            aria-label="Message"
            aria-describedby={hintId}
            disabled={disabled}
            className="max-h-[min(40dvh,14rem)] min-h-11 flex-1 resize-none bg-transparent px-1 py-2.5 leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
          />

          <ComposerIconButton label="Voice input" onClick={() => showNotice(VOICE_UNAVAILABLE)}>
            <Mic className="size-5" aria-hidden="true" />
          </ComposerIconButton>

          {generating && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              title="Stop generating"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-foreground text-background outline-none hover:bg-foreground/85 focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Square className="size-4 fill-current" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send message"
              disabled={!canSend}
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity outline-none hover:bg-primary/90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-35"
            >
              {submitting ? (
                <Loader2 className="size-5 animate-spin" aria-hidden="true" />
              ) : (
                <ArrowUp className="size-5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex items-start justify-between gap-3 px-1 text-xs text-muted-foreground">
        <p id={hintId}>
          {blockedReason ?? footnote}
          <span className="sr-only">
            {" "}
            On a keyboard, press Enter to send and Shift+Enter for a new line.
          </span>
        </p>
        {value.length >= COUNTER_THRESHOLD ? (
          <p className="shrink-0 tabular-nums" aria-live="polite">
            {value.length.toLocaleString()} / {MESSAGE_MAX_LENGTH.toLocaleString()}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function ComposerIconButton({
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
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
    >
      {children}
    </button>
  );
}
