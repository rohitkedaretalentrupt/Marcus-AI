"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { PublicUser } from "@/lib/auth/types";

const CurrentUserContext = createContext<PublicUser | null>(null);

/**
 * Makes the signed-in user (resolved on the server by `requireUser()`)
 * available to client components without an extra session fetch. Display
 * only: authorization always happens on the server.
 */
export function CurrentUserProvider({ user, children }: { user: PublicUser; children: ReactNode }) {
  return <CurrentUserContext.Provider value={user}>{children}</CurrentUserContext.Provider>;
}

export function useCurrentUser(): PublicUser {
  const user = useContext(CurrentUserContext);
  if (!user) throw new Error("useCurrentUser must be used inside <CurrentUserProvider>");
  return user;
}
