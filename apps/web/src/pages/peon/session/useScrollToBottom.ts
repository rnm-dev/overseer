import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";

type FrameRequest = (callback: FrameRequestCallback) => number;

export function createBottomFrameScheduler(
  isPinned: () => boolean,
  scroll: () => void,
  requestFrame: FrameRequest,
  cancelFrame: (id: number) => void,
) {
  let frame: number | null = null;
  return {
    schedule() {
      if (frame !== null) return;
      frame = requestFrame(() => {
        frame = null;
        if (isPinned()) scroll();
      });
    },
    dispose() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
    },
  };
}

export function useScrollToBottom(
  stickToBottomRef: MutableRefObject<boolean>,
  history: unknown,
  live: unknown,
  transcriptRef: RefObject<HTMLElement | null>,
  sessionKey: string,
) {
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const schedulerRef = useRef<ReturnType<typeof createBottomFrameScheduler> | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = createBottomFrameScheduler(
      () => stickToBottomRef.current,
      () => window.scrollTo({ top: document.documentElement.scrollHeight }),
      (callback) => requestAnimationFrame(callback),
      (id) => cancelAnimationFrame(id),
    );
  }
  const scheduleScrollToBottom = useCallback(() => schedulerRef.current?.schedule(), []);

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
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom, stickToBottomRef]);

  // React updates get one immediate correction. A ResizeObserver keeps following
  // later layout growth (images, diagrams, highlighted code, working labels) that
  // can otherwise leave a long transcript several rows short of the real bottom.
  useLayoutEffect(scheduleScrollToBottom, [history, live, scheduleScrollToBottom]);

  useLayoutEffect(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scheduleScrollToBottom();
  }, [scheduleScrollToBottom, sessionKey, stickToBottomRef]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(scheduleScrollToBottom);
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [scheduleScrollToBottom, transcriptRef, sessionKey]);

  useEffect(() => () => schedulerRef.current?.dispose(), []);

  return { showScrollToBottom, scrollToBottom };
}
