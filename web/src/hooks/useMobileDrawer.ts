import { useEffect, useState } from "react";

// Keep the page locked until the closing motion has fully cleared the viewport.
// This also prevents portaled session controls from popping back in mid-exit.
const DRAWER_EXIT_MS = 400;

export function useMobileDrawer() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerActive, setDrawerActive] = useState(false);

  useEffect(() => {
    if (drawerOpen) {
      setDrawerActive(true);
      return;
    }
    if (!drawerActive) return;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setDrawerActive(false), reducedMotion ? 0 : DRAWER_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [drawerActive, drawerOpen]);

  useEffect(() => {
    if (!drawerActive) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.body.classList.add("peon-drawer-open");
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      document.body.classList.remove("peon-drawer-open");
      document.removeEventListener("keydown", onKey);
    };
  }, [drawerActive]);

  return { drawerOpen, setDrawerOpen };
}
