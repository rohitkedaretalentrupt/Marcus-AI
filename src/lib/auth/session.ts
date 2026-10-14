import "server-only";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { cache } from "react";

import { UnauthorizedError } from "@/lib/errors/app-error";
import { prismaUserRepository } from "@/server/users/user-repository";

import { getAuthOptions } from "./config";
import { LOGIN_PATH } from "./routes";
import type { PublicUser } from "./types";

/**
 * The signed-in user, or null. The session cookie only proves *which* user id
 * signed in; the user is always re-read from the database, so this never
 * returns a deleted account. Cached per request.
 *
 * Ownership checks in later phases must use this id — never a user id sent by
 * the client.
 */
export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  const session = await getServerSession(getAuthOptions());
  const userId = session?.user?.id;
  if (!userId) return null;
  return prismaUserRepository.findPublicById(userId);
});

/** For pages and layouts: the signed-in user, or a redirect to the login page. */
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) redirect(LOGIN_PATH);
  return user;
}

/** For route handlers: the signed-in user, or a 401 JSON error via `withErrorHandling`. */
export async function requireApiUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();
  return user;
}
