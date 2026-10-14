import type { ComponentProps } from "react";

import { cn } from "@/lib/utils/cn";

const WIDTHS = {
  narrow: "max-w-2xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

type PageContainerProps = ComponentProps<"div"> & {
  width?: keyof typeof WIDTHS;
};

/** Horizontally centred content column with mobile-first gutters. */
export function PageContainer({ className, width = "default", ...props }: PageContainerProps) {
  return (
    <div
      className={cn("mx-auto w-full px-4 sm:px-6 lg:px-8", WIDTHS[width], className)}
      {...props}
    />
  );
}
