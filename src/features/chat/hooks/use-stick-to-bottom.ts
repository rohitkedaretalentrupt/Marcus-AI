import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

/** How close (px) to the bottom still counts as "following" the conversation. */
const FOLLOW_THRESHOLD_PX = 96;

interface StickToBottom {
  containerRef: RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  onScroll: () => void;
  /** Force-follow on the next content change (e.g. the user just sent a message). */
  requestFollow: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Content grew outside `contentKey` (e.g. a streaming reply): follow it if the reader is following. */
  keepFollowing: () => void;
}

/**
 * Keeps a scroll container pinned to its newest content while the reader is
 * at (or near) the bottom, but never yanks them down while they read older
 * messages. `contentKey` must change whenever content is appended — a future
 * streaming assistant reply can pass its growing length to keep following.
 */
export function useStickToBottom(contentKey: unknown): StickToBottom {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const element = containerRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distance <= FOLLOW_THRESHOLD_PX;
    followRef.current = atBottom;
    setIsAtBottom(atBottom);
  }, []);

  const keepFollowing = useCallback(() => {
    if (followRef.current) scrollToBottom();
  }, [scrollToBottom]);

  const requestFollow = useCallback(() => {
    followRef.current = true;
  }, []);

  // Runs on mount (open the conversation at its latest message) and whenever
  // content changes; before paint, so there is no visible jump.
  useLayoutEffect(() => {
    if (followRef.current) scrollToBottom();
  }, [contentKey, scrollToBottom]);

  return { containerRef, isAtBottom, onScroll, requestFollow, scrollToBottom, keepFollowing };
}
