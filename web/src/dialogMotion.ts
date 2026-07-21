export const DIALOG_EXIT_MS = 300;

export function sheetDragProgress(distance: number, viewportHeight: number): number {
  const travel = Math.max(240, viewportHeight * 0.55);
  return Math.min(1, Math.max(0, distance) / travel);
}

export function shouldDismissSheet(distance: number, velocity: number, panelHeight: number): boolean {
  const distanceThreshold = Math.min(160, Math.max(88, panelHeight * 0.24));
  return distance >= distanceThreshold || (distance >= 18 && velocity >= 0.72);
}
