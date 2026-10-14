import { redirect } from "next/navigation";

import { DEFAULT_AUTHENTICATED_PATH } from "@/lib/auth/routes";

// There is no public landing page yet; the root (like the PWA start_url) opens
// the chat, and signed-out visitors are sent on to /login by the proxy.
export default function RootPage() {
  redirect(DEFAULT_AUTHENTICATED_PATH);
}
