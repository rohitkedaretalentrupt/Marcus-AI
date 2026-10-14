import type { ReactNode } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { AppShell } from "@/components/layout/app-shell";
import { CurrentUserProvider } from "@/features/auth/components/current-user-provider";
import { UserMenu } from "@/features/auth/components/user-menu";
import { requireUser } from "@/lib/auth/session";

/**
 * Authenticated area. `proxy.ts` redirects signed-out visitors early; this
 * check is the real guard (it also rejects cookies of deleted users). Pages
 * that load user data must still call `requireUser()` themselves, because
 * layouts are not re-run on every client-side navigation.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  return (
    <CurrentUserProvider user={user}>
      <AppShell header={<AppHeader actions={<UserMenu />} />}>{children}</AppShell>
    </CurrentUserProvider>
  );
}
