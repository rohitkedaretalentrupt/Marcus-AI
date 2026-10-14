"use client";

import { Wordmark } from "@/components/layout/brand-link";
import { siteConfig } from "@/lib/config/site";

/** Fill the composer only — the user reviews and sends; nothing is invoked. */
export const SUGGESTED_PROMPTS = [
  "Format my resume",
  "Make it ATS-friendly",
  "Make it one page",
] as const;

export function ChatEmptyState({ onSuggestion }: { onSuggestion: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-10 text-center">
      <h2 className="mb-1">
        <span aria-hidden="true">
          <Wordmark size="lg" />
        </span>
        <span className="sr-only">{siteConfig.name}</span>
      </h2>
      <p className="mt-2 text-sm text-pretty text-muted-foreground">
        Attach your resume (PDF, DOCX or image) and tell me how you&apos;d like it formatted.
      </p>
      <ul className="mt-6 flex flex-wrap justify-center gap-2" aria-label="Suggestions">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => onSuggestion(prompt)}
              className="min-h-11 rounded-full border bg-background px-4 text-sm outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 md:min-h-9"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
