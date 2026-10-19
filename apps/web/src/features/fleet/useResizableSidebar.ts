import { writeStoredValue } from "../../shared/storedValue";
import { useCallback, useEffect, useState } from "react";

const SIDEBAR_WIDTH_KEY = "overseer.peon-sidebar-width";
const DEFAULT_SIDEBAR_WIDTH = 256;
const MIN_SIDEBAR_WIDTH = 208;
const MAX_SIDEBAR_WIDTH = 480;

function savedSidebarWidth(): number {
  const saved = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= MIN_SIDEBAR_WIDTH && saved <= MAX_SIDEBAR_WIDTH
    ? saved
    : DEFAULT_SIDEBAR_WIDTH;
}

/** Pointer-driven, persisted sidebar width published as `--peon-sidebar-width`. */
export function useResizableSidebar() {
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (!resizing) return;
    const resize = (event: PointerEvent) => {
      // Leave enough room for the current page to remain useful on narrower desktops.
      const maximum = Math.min(MAX_SIDEBAR_WIDTH, window.innerWidth - 320);
      setSidebarWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(maximum, event.clientX)));
    };
    const stop = () => setResizing(false);
    document.documentElement.classList.add("peon-sidebar-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.documentElement.classList.remove("peon-sidebar-resizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  useEffect(() => {
    if (!resizing) writeStoredValue(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [resizing, sidebarWidth]);

  // Headers and the session composer live outside the sidebar's flex layout.
  // Publish the width so those fixed pieces share the pane's desktop boundary.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--peon-sidebar-width", `${sidebarWidth}px`);
    return () => {
      root.style.removeProperty("--peon-sidebar-width");
    };
  }, [sidebarWidth]);

  const startResize = useCallback(() => setResizing(true), []);
  // Keyboard nudges clamp to the absolute bounds, not the viewport-aware maximum.
  const nudgeWidth = useCallback((change: number) => {
    setSidebarWidth((width) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width + change)));
  }, []);

  return { sidebarWidth, minWidth: MIN_SIDEBAR_WIDTH, maxWidth: MAX_SIDEBAR_WIDTH, startResize, nudgeWidth };
}
