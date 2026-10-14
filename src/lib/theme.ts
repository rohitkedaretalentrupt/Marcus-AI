/**
 * Light/dark theme. The choice is a per-device preference stored in
 * localStorage; dark (the brand look) is the default. The `.dark` class on
 * <html> switches the CSS tokens in globals.css.
 */

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";
export const THEME_STORAGE_KEY = "theme";
export const THEME_COLORS: Record<Theme, string> = { light: "#ffffff", dark: "#000000" };

/**
 * Runs in <head> before the first paint, so the saved theme is applied
 * without a flash. Kept tiny and dependency-free; storage may be blocked.
 */
export const themeInitScript = `(function(){var t;try{t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(t!=="light"&&t!=="dark")t=${JSON.stringify(
  DEFAULT_THEME,
)};var r=document.documentElement;r.classList.toggle("dark",t==="dark");r.style.colorScheme=t;})();`;

/** The theme currently applied to the document. */
export function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Matches the browser UI colour (address bar, PWA title bar) to the theme. */
export function syncThemeColor(theme: Theme): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = THEME_COLORS[theme];
  }
}

/** Applies and remembers a theme. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  syncThemeColor(theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode / blocked storage: the theme still applies for this page.
  }
}
