import { redirect } from "next/navigation";

import { DEFAULT_AUTHENTICATED_PATH } from "@/lib/auth/routes";

/** The dashboard was removed; old links and bookmarks land in the chat. */
export default function DashboardPage(): never {
  redirect(DEFAULT_AUTHENTICATED_PATH);
}
