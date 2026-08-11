/**
 * Whether the transcript follows new output, in one rule: it follows while the
 * operator is standing at the bottom of it.
 *
 * The previous machinery inferred that from Virtuoso's at-bottom transitions
 * and suppressed them for 800 ms after each auto-scroll, so a scroll that
 * arrived while an agent was appending rows was ignored: on a long turn the
 * rows came faster than the suppression window closed, and reading history
 * meant being dragged back to the bottom by the next event. What remains is
 * position, which is not a guess — the browser reports it, and every scroll
 * event answers the question outright.
 *
 * Scrolling is instant for the same reason. A smooth animation is in flight
 * while the list keeps growing: its own intermediate positions read as "not at
 * the bottom", and its target is stale before it lands.
 */

/**
 * Sub-pixel rounding, a scrollbar's own rounding, and a row whose height
 * settles one frame after it paints all leave a few pixels behind. They are
 * standing at the bottom.
 */
export const TRANSCRIPT_AT_BOTTOM_PX = 24;

export interface TranscriptScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function transcriptDistanceFromBottom(metrics: TranscriptScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop);
}

/** Whether new output should keep the viewport pinned to the newest row. */
export function transcriptFollowsOutput(metrics: TranscriptScrollMetrics): boolean {
  return transcriptDistanceFromBottom(metrics) <= TRANSCRIPT_AT_BOTTOM_PX;
}

/**
 * The jump-to-newest control is not the inverse of following: one screen of
 * distance is a deliberate departure, while a few rows is still the tail of the
 * conversation and does not need a button over it.
 */
export function transcriptShowsJumpToNewest(metrics: TranscriptScrollMetrics): boolean {
  return transcriptDistanceFromBottom(metrics) >= metrics.clientHeight;
}
