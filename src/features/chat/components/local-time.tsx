"use client";

import { useIsClient } from "../hooks/use-is-client";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function isSameLocalDay(a: Date, b: Date) {
  return a.toDateString() === b.toDateString();
}

/** Renders in the viewer's time zone (client only, to avoid hydration mismatches). */
export function LocalTime({ iso, className }: { iso: string; className?: string }) {
  const isClient = useIsClient();
  const date = new Date(iso);
  const label = isClient
    ? (isSameLocalDay(date, new Date()) ? timeFormat : dateTimeFormat).format(date)
    : "";

  return (
    <time
      dateTime={iso}
      className={className}
      title={isClient ? dateTimeFormat.format(date) : undefined}
    >
      {label}
    </time>
  );
}
