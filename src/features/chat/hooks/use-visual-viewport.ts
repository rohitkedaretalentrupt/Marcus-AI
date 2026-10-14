import { useEffect } from "react";

/**
 * Mirrors the visual viewport into CSS variables (`--app-height`,
 * `--app-offset-top`) so a fixed full-screen layout can shrink above the
 * on-screen keyboard.
 *
 * Android Chrome already resizes the layout (viewport `interactive-widget=
 * resizes-content`), but iOS Safari overlays the keyboard and only shrinks
 * the *visual* viewport — without this the composer would sit under the
 * keyboard. Falls back to `100dvh` where the API is missing.
 */
export function useVisualViewportVariables(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const root = document.documentElement;
    const update = () => {
      root.style.setProperty("--app-height", `${viewport.height}px`);
      root.style.setProperty("--app-offset-top", `${viewport.offsetTop}px`);
    };

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-offset-top");
    };
  }, []);
}
