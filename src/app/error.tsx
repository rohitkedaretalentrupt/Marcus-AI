"use client";

import { Button } from "@/components/ui/button";

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Route-level error boundary. In production Next.js strips server error
 * messages, so we never render `error.message`; only the opaque digest is
 * shown so support can match it with server logs.
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 pt-safe pb-safe text-center">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        An unexpected error occurred. Please try again.
      </p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
      ) : null}
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
