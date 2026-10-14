"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItem } from "@/lib/config/navigation";
import { cn } from "@/lib/utils/cn";

interface MainNavProps {
  items: readonly NavItem[];
}

export function MainNav({ items }: MainNavProps) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex items-center gap-1 overflow-x-auto">
      {items.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "touch-target items-center rounded-md px-2 text-sm font-medium transition-colors sm:px-3",
              item.wideOnly ? "hidden sm:inline-flex" : "inline-flex",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
