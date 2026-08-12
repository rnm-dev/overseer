// Zoom for the shared image view. Fitting is the default and is not a zoom
// level: it is whatever ratio makes the image fit, and it never enlarges a
// small image — a 32px icon is shown at 32px, not blown up to fill the pane.

export const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 8];

export interface Size {
  width: number;
  height: number;
}

export function fitScale(natural: Size, box: Size): number {
  if (natural.width <= 0 || natural.height <= 0 || box.width <= 0 || box.height <= 0) return 1;
  return Math.min(1, box.width / natural.width, box.height / natural.height);
}

// Stepping starts from whatever the operator is actually looking at, so the
// first click after fitting moves relative to the fitted ratio rather than
// jumping to a fixed level.
export function nextZoom(current: number, direction: 1 | -1): number {
  const first = ZOOM_STEPS[0]!;
  const last = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
  if (direction === 1) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? last;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? first;
}

export const canZoom = (current: number, direction: 1 | -1) => nextZoom(current, direction) !== current;

export function zoomLabel(scale: number): string {
  return `${scale >= 0.1 ? Math.round(scale * 100) : Math.round(scale * 1000) / 10}%`;
}
