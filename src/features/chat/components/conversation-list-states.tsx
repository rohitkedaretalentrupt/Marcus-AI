"use client";

import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

const SKELETON_WIDTHS = ["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4"];

export function ConversationListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading conversations" className="space-y-2 px-2 pt-1">
      <div className="h-3 w-16 animate-pulse rounded bg-muted" />
      {SKELETON_WIDTHS.map((width, index) => (
        <div key={index} className={`h-4 ${width} animate-pulse rounded bg-muted`} />
      ))}
    </div>
  );
}

export function ConversationListError() {
  const router = useRouter();
  return (
    <div role="alert" className="space-y-2 px-2 py-3 text-sm">
      <p className="text-muted-foreground">Couldn&apos;t load your conversations.</p>
      <Button variant="outline" size="sm" onClick={() => router.refresh()}>
        Try again
      </Button>
    </div>
  );
}
