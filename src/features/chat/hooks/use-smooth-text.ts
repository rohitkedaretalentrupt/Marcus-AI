import { useEffect, useState } from "react";

/** Fraction of the not-yet-shown text revealed per frame: catches up within a few frames. */
const CATCH_UP = 1 / 6;

/**
 * Reveals text that has really arrived over the next few animation frames,
 * so network chunks read as an even flow instead of jumps. It never shows
 * text that has not arrived and never waits on a timer: once `active` is
 * false, everything received is shown at once. `resetKey` starts a new reply.
 */
export function useSmoothText(text: string, active: boolean, resetKey: unknown): string {
  const [progress, setProgress] = useState({ key: resetKey, shown: 0 });
  const shown = progress.key === resetKey ? progress.shown : 0;

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const tick = () => {
      setProgress((current) => {
        const from = current.key === resetKey ? current.shown : 0;
        if (from >= text.length)
          return current.key === resetKey ? current : { key: resetKey, shown: from };
        const step = Math.max(2, Math.ceil((text.length - from) * CATCH_UP));
        return { key: resetKey, shown: Math.min(text.length, from + step) };
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, active, resetKey]);

  return active ? text.slice(0, shown) : text;
}
