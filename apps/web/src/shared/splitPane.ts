import { useCallback, useEffect, useRef, useState } from "react";

// A movable separator between two panes of one surface. The Peon sidebar owns
// its own resizer because it publishes a CSS variable the fixed chrome reads;
// this is the same gesture for panes that only have to divide their container.

export interface SplitBounds {
  min: number;
  max: number;
  // Room the second pane must keep, whatever the container's width.
  minTrailing: number;
}

// Clamping is where a split goes wrong — a container narrower than min + the
// trailing room has to give the trailing pane its share first.
export function clampSplit(width: number, container: number, { min, max, minTrailing }: SplitBounds): number {
  const ceiling = Math.min(max, Math.max(min, container - minTrailing));
  return Math.round(Math.max(min, Math.min(ceiling, width)));
}

export function readStoredSplit(key: string, fallback: number, bounds: SplitBounds): number {
  const saved = Number(window.localStorage.getItem(key));
  return Number.isFinite(saved) && saved >= bounds.min && saved <= bounds.max ? saved : fallback;
}

const RESIZING_CLASS = "peon-sidebar-resizing";
const KEYBOARD_STEP = 16;

export function useSplitPane({ storageKey, defaultWidth, bounds, minViewportWidth = 1024 }: {
  storageKey: string;
  defaultWidth: number;
  bounds: SplitBounds;
  minViewportWidth?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => readStoredSplit(storageKey, defaultWidth, bounds));
  const [resizing, setResizing] = useState(false);
  // Below the breakpoint the panes stack, and a horizontal split has nothing
  // to divide — the separator is not rendered and the width is not applied.
  const [side, setSide] = useState(() => window.innerWidth >= minViewportWidth);

  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${minViewportWidth}px)`);
    const sync = () => setSide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, [minViewportWidth]);

  const apply = useCallback((next: number) => {
    setWidth(clampSplit(next, container.current?.getBoundingClientRect().width ?? Infinity, bounds));
  }, [bounds]);

  useEffect(() => {
    if (!resizing) return;
    const resize = (event: PointerEvent) => {
      const rect = container.current?.getBoundingClientRect();
      if (rect) setWidth(clampSplit(event.clientX - rect.left, rect.width, bounds));
    };
    const stop = () => setResizing(false);
    // While the pointer is down the whole document keeps the resize cursor and
    // stops selecting text, wherever the pointer wanders.
    document.documentElement.classList.add(RESIZING_CLASS);
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.documentElement.classList.remove(RESIZING_CLASS);
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [bounds, resizing]);

  useEffect(() => {
    if (!resizing) window.localStorage.setItem(storageKey, String(width));
  }, [resizing, storageKey, width]);

  // A width stored on a wide monitor would starve the trailing pane in a
  // narrow window, so the split is re-clamped whenever the container can have
  // changed size rather than only while dragging.
  useEffect(() => {
    if (!side) return;
    const reclamp = () => apply(width);
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [apply, side, width]);

  const separatorProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-valuemin": bounds.min,
    "aria-valuemax": bounds.max,
    "aria-valuenow": Math.round(width),
    tabIndex: 0,
    onPointerDown: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      setResizing(true);
    },
    onKeyDown: (event: { key: string; preventDefault: () => void }) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      apply(width + (event.key === "ArrowLeft" ? -KEYBOARD_STEP : KEYBOARD_STEP));
    },
  };

  return { container, width: side ? width : undefined, side, resizing, separatorProps };
}
