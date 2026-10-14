import NextAuth from "next-auth";

import { getAuthOptions } from "@/lib/auth/config";

interface NextAuthRouteContext {
  params: Promise<{ nextauth: string[] }>;
}

// Options are resolved per request (lazily) so the build does not need secrets.
async function handler(request: Request, context: NextAuthRouteContext): Promise<Response> {
  return NextAuth(getAuthOptions())(request, context);
}

export { handler as GET, handler as POST };
