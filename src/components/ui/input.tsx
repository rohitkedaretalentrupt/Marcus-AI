import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // h-11 (44px) on touch screens; text stays ≥16px on mobile (see globals.css) to avoid iOS zoom.
        "flex h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 shadow-xs transition-[color,box-shadow] outline-none md:h-10 md:text-sm",
        "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
