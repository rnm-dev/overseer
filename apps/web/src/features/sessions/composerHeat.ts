import { useCallback, useEffect, useRef } from "react";

/** Each keystroke adds this much heat; heat is capped at 1. */
export const HEAT_PER_KEYSTROKE = 0.14;
/** Exponential decay time constant: heat falls to ~37% this long after typing stops. */
export const HEAT_DECAY_MS = 350;
const HEAT_FLOOR = 0.005;

/** Heat after `elapsedMs` of decay plus an optional keystroke. Bounded to [0, 1]. */
export function nextHeat(heat: number, elapsedMs: number, keystroke: boolean): number {
  const decayed = heat * Math.exp(-Math.max(0, elapsedMs) / HEAT_DECAY_MS);
  const next = keystroke ? decayed + HEAT_PER_KEYSTROKE * (1 - decayed) : decayed;
  return next < HEAT_FLOOR ? 0 : Math.min(1, next);
}

function heatEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--ov-composer-heat-shadow").trim();
  return value !== "" && value !== "none";
}

/**
 * Typing heats the composer glow: faster typing settles at a brighter level
 * (each keystroke closes a fraction of the gap to 1), and it cools quickly
 * once typing stops. Writes `--composer-heat` straight to the element so the
 * animation never re-renders React.
 */
export function useComposerHeat<T extends HTMLElement>() {
  const nodeRef = useRef<T | null>(null);
  const heatRef = useRef(0);
  const lastRef = useRef(0);
  const frameRef = useRef(0);

  const tick = useCallback(() => {
    const now = performance.now();
    heatRef.current = nextHeat(heatRef.current, now - lastRef.current, false);
    lastRef.current = now;
    nodeRef.current?.style.setProperty("--composer-heat", heatRef.current.toFixed(3));
    frameRef.current = heatRef.current > 0 ? requestAnimationFrame(tick) : 0;
  }, []);

  const bump = useCallback(() => {
    if (!heatEnabled()) return;
    const now = performance.now();
    heatRef.current = nextHeat(heatRef.current, frameRef.current ? now - lastRef.current : 0, true);
    lastRef.current = now;
    if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
  }, [tick]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  return { nodeRef, bump };
}
