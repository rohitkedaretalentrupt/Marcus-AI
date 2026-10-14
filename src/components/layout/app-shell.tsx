import type { ReactNode } from "react";

import { cn } from "@/lib/utils/cn";

interface AppShellProps {
  header: ReactNode;
  children: ReactNode;
  /**
   * Content pinned to the bottom of the viewport (e.g. the future chat
   * composer). It stays above the home indicator via safe-area padding, and
   * because the shell is sized with `dvh` it follows the on-screen keyboard
   * on browsers that resize the layout viewport.
   */
  footer?: ReactNode;
  className?: string;
}

/**
 * Full-height app frame: sticky header, a single scrolling main region, and
 * an optional fixed footer. Mobile-first; desktop simply gets more room.
 */
export function AppShell({ header, children, footer, className }: AppShellProps) {
  return (
    <div className={cn("flex min-h-dvh flex-col", className)}>
      {header}
      <main id="main-content" className="flex min-w-0 flex-1 flex-col">
        {children}
      </main>
      {footer ? (
        <div className="sticky bottom-0 z-30 border-t bg-background/95 px-safe pb-safe backdrop-blur">
          {footer}
        </div>
      ) : null}
    </div>
  );
}
