const BUBBLE_WIDTHS = ["w-2/3", "w-1/2", "w-3/5"];

export default function ConversationLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading conversation"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="shrink-0 border-b pt-safe">
        <div className="flex h-14 items-center px-4">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl flex-1 space-y-6 px-4 py-6 md:px-6">
        {BUBBLE_WIDTHS.map((width, index) => (
          <div key={index} className="flex justify-end">
            <div className={`h-10 ${width} animate-pulse rounded-2xl bg-muted`} />
          </div>
        ))}
      </div>
      <div className="mx-auto w-full max-w-3xl px-3 pt-2 pb-[max(var(--safe-bottom),0.75rem)] md:px-4">
        <div className="h-[3.25rem] animate-pulse rounded-2xl border bg-muted/50" />
      </div>
    </div>
  );
}
