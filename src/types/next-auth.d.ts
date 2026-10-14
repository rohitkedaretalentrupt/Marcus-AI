import "next-auth";

declare module "next-auth" {
  /** Our session callback exposes only the user id; everything else is read from the DB. */
  interface Session {
    user: { id: string };
    expires: string;
  }
}
