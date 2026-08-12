import { useEffect, useState } from "react";

// A pane that should end where the viewport ends. The chrome above it — the
// fixed pane header, a page header, a subnav that may wrap to two rows — is
// not a number worth guessing, so the pane measures where it actually starts
// and claims the rest. A viewport too short to honour the minimum keeps the
// minimum and lets the page scroll, which is what a laptop in a small window
// wants.

export function viewportFillHeight(top: number, bottomGap: number, minHeight: number): string {
  return `max(${minHeight}px, calc(100dvh - ${Math.max(0, Math.round(top + bottomGap))}px))`;
}

// The gap below the pane belongs to whichever ancestor pads the page. Walking
// up to it beats hardcoding the wrapper's padding in two places.
export function pageBottomGap(node: HTMLElement, depth = 5): number {
  let current: HTMLElement | null = node;
  for (let step = 0; step < depth && current; step++) {
    const padding = parseFloat(getComputedStyle(current).paddingBottom) || 0;
    if (padding > 0) return padding;
    current = current.parentElement;
  }
  return 0;
}

export function useViewportFill({ minHeight = 320, minViewportWidth = 1024 } = {}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState<string | undefined>();

  useEffect(() => {
    if (!node) return;
    const measure = () => {
      if (window.innerWidth < minViewportWidth) return setHeight(undefined);
      // Document-space top, so a scrolled page still measures the same.
      const top = node.getBoundingClientRect().top + window.scrollY;
      setHeight(viewportFillHeight(top, pageBottomGap(node), minHeight));
    };
    measure();
    // The body, not the pane: observing the pane would watch the height this
    // very effect writes.
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [minHeight, minViewportWidth, node]);

  return { ref: setNode, height };
}
