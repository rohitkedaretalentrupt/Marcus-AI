export interface NavItem {
  label: string;
  href: string;
  /** Shown in the header nav from the sm breakpoint up only (it is in the account menu on phones). */
  wideOnly?: boolean;
}

/** Only routes that actually exist belong here. */
export const mainNavigation: readonly NavItem[] = [
  { label: "Chat", href: "/chat" },
  { label: "Templates", href: "/templates" },
];
