import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { BrandLink } from "@/components/layout/brand-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { DEFAULT_AUTHENTICATED_PATH, LOGIN_PATH } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";

/**
 * Public auth pages. Mobile: a full-width, top-aligned column, so the form
 * does not jump when the on-screen keyboard opens. Larger screens: a centred card.
 */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  // Database-checked, so a stale cookie for a deleted user cannot cause a redirect loop.
  if (await getCurrentUser()) redirect(DEFAULT_AUTHENTICATED_PATH);

  return (
    <div className="relative flex min-h-dvh flex-col pt-safe px-safe pb-safe sm:items-center sm:justify-center sm:py-10">
      <ThemeToggle className="absolute top-[max(0.5rem,var(--safe-top))] right-[max(0.5rem,var(--safe-right))]" />
      <div className="w-full px-4 pt-6 sm:max-w-md sm:px-0 sm:pt-0">
        <div className="mb-8 flex justify-center sm:mb-10">
          <BrandLink href={LOGIN_PATH} size="lg" />
        </div>
        <main
          id="main-content"
          className="sm:rounded-xl sm:border sm:bg-card sm:p-8 sm:text-card-foreground sm:shadow-sm"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
