import { useCallback, useEffect, useState, type MutableRefObject } from "react";

export function useScrollToBottom(stickToBottomRef: MutableRefObject<boolean>, history: unknown, live: unknown) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  useEffect(() => {
    const nearBottomPx = 80;
    const onScroll = () => {
      const { scrollY, innerHeight } = window;
      const { scrollHeight } = document.documentElement;
      const atBottom = scrollHeight - (scrollY + innerHeight) <= nearBottomPx;
      stickToBottomRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [stickToBottomRef]);

  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }, [stickToBottomRef]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (stickToBottomRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
    });
    return () => cancelAnimationFrame(id);
  }, [history, live, stickToBottomRef]);

  return { showScrollToBottom, scrollToBottom };
}
