import type { ReactNode } from "react";

import { mainNavigation } from "@/lib/config/navigation";

import { ThemeToggle } from "../theme-toggle";

import { BrandLink } from "./brand-link";
import { MainNav } from "./main-nav";
import { PageContainer } from "./page-container";

interface AppHeaderProps {
  /** Right-hand slot, e.g. the account menu. */
  actions?: ReactNode;
}

export function AppHeader({ actions }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/95 pt-safe px-safe backdrop-blur">
      <a
        href="#main-content"
        className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <PageContainer width="wide" className="flex h-header items-center justify-between gap-3">
        <BrandLink href="/chat" compact className="shrink-0" />
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          <MainNav items={mainNavigation} />
          {actions}
          {/* Light/dark switch: always the top-right corner. */}
          <ThemeToggle />
        </div>
      </PageContainer>
    </header>
  );
}
