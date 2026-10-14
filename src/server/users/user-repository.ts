import "server-only";

import { getDb } from "@/lib/db/client";
import { Prisma } from "@/generated/prisma/client";

import { DuplicateEmailError, type UserRepository } from "./types";

/** Columns safe to expose. Every query returning a user to callers uses this. */
const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const satisfies Prisma.UserSelect;

export const prismaUserRepository: UserRepository = {
  findPublicById(id) {
    return getDb().user.findUnique({ where: { id }, select: publicUserSelect });
  },

  async findCredentialsByEmail(normalizedEmail) {
    const row = await getDb().user.findUnique({
      where: { email: normalizedEmail },
      select: { ...publicUserSelect, passwordHash: true },
    });
    if (!row) return null;
    const { passwordHash, ...user } = row;
    return { user, passwordHash };
  },

  async create(data) {
    try {
      return await getDb().user.create({ data, select: publicUserSelect });
    } catch (error) {
      // Unique violation: covers the race where two sign-ups for the same
      // email pass the pre-check concurrently.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new DuplicateEmailError();
      }
      throw error;
    }
  },
};
