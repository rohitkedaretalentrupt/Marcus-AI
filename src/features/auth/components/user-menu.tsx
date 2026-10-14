"use client";

import { LogOut, User } from "lucide-react";
import { signOut } from "next-auth/react";
import { useState } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LOGIN_PATH } from "@/lib/auth/routes";
import { cn } from "@/lib/utils/cn";

import { useCurrentUser } from "./current-user-provider";

function initials(name: string | null, email: string | null): string | null {
  const source = name?.trim() || email?.trim();
  if (!source) return null;
  const parts = source.split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? `${parts[0]![0]}${parts.at(-1)![0]}` : source[0];
  return letters?.toUpperCase() ?? null;
}

interface UserMenuProps {
  /** "header": avatar only. "sidebar": full-width row with the name, opening upwards. */
  variant?: "header" | "sidebar";
}

export function UserMenu({ variant = "header" }: UserMenuProps) {
  const user = useCurrentUser();
  const [signingOut, setSigningOut] = useState(false);
  const label = initials(user.name, user.email);
  const isSidebar = variant === "sidebar";

  const avatar = (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
      {label ?? <User className="size-4" aria-hidden="true" />}
    </span>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className={cn(
          "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
          isSidebar
            ? "flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-accent"
            : "inline-flex size-11 shrink-0 items-center justify-center rounded-full",
        )}
      >
        {avatar}
        {isSidebar ? (
          <span className="min-w-0 truncate text-sm font-medium">{user.name ?? user.email}</span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={isSidebar ? "start" : "end"} side={isSidebar ? "top" : "bottom"}>
        <DropdownMenuLabel className="space-y-0.5">
          {user.name ? <p className="truncate font-medium">{user.name}</p> : null}
          {user.email ? (
            <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={(event) => {
            // Keep the menu open while the request runs; navigation follows.
            event.preventDefault();
            setSigningOut(true);
            void signOut({ callbackUrl: LOGIN_PATH });
          }}
        >
          <LogOut aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
