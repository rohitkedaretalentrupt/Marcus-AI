import Link from "next/link";

import { siteConfig } from "@/lib/config/site";
import { cn } from "@/lib/utils/cn";

interface BrandLinkProps {
  href: string;
  className?: string;
  /** Mark only below the sm breakpoint (the name stays the accessible label). */
  compact?: boolean;
  /** Larger wordmark (sign-in pages). */
  size?: "default" | "lg";
}

/** The brand's red dot (as on the "i" of the HireTalent logo). */
function RedDot({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("block rounded-full bg-primary", className)} />;
}

/**
 * Wordmark in the brand style: thin, upper-case, widely spaced white letters
 * with one red dot. The first "i" of the name is drawn as a dotless "ı" with
 * the red dot above it (like the logo); names without an "i" get the dot as
 * a leading mark.
 */
export function Wordmark({
  name = siteConfig.name,
  size = "default",
}: {
  name?: string;
  size?: "default" | "lg";
}) {
  const index = name.search(/i/i);
  const dot = size === "lg" ? "size-2" : "size-1.5";
  return (
    <span
      className={cn(
        "inline-flex items-baseline font-light whitespace-nowrap",
        size === "lg" ? "text-2xl tracking-[0.35em]" : "text-base tracking-[0.3em]",
      )}
    >
      {index === -1 ? (
        <>
          <RedDot className={cn(dot, "mr-2 self-center")} />
          {name.toUpperCase()}
        </>
      ) : (
        <>
          {name.slice(0, index).toUpperCase()}
          <span className="relative inline-block">
            ı{/* Centred over the stem: the glyph box also contains the letter-spacing. */}
            <RedDot
              className={cn(
                dot,
                "absolute top-[0.05em] -translate-x-1/2",
                size === "lg" ? "left-[calc(50%-0.175em)]" : "left-[calc(50%-0.15em)]",
              )}
            />
          </span>
          {name.slice(index + 1).toUpperCase()}
        </>
      )}
    </span>
  );
}

export function BrandLink({ href, className, compact = false, size = "default" }: BrandLinkProps) {
  return (
    <Link
      href={href}
      aria-label={siteConfig.name}
      className={cn(
        "-ml-1 inline-flex min-h-11 items-center gap-2 rounded-md px-1 text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        // Mark only on phones: keep a 44px touch target.
        compact ? "min-w-11 justify-center sm:justify-start" : "min-w-0",
        className,
      )}
    >
      {compact ? (
        <span
          aria-hidden="true"
          className="relative flex size-9 shrink-0 items-center justify-center rounded-md border border-border text-base font-light sm:hidden"
        >
          {siteConfig.name.charAt(0).toUpperCase()}
          <RedDot className="absolute top-1.5 right-1.5 size-1.5" />
        </span>
      ) : null}
      <span aria-hidden="true" className={cn("min-w-0", compact && "hidden sm:inline-flex")}>
        <Wordmark name={siteConfig.name} size={size} />
      </span>
    </Link>
  );
}
