export const TRANSCRIPT_AT_BOTTOM_PX = 4;

export interface TranscriptScrollPosition {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

export function transcriptDistanceFromBottom(position: TranscriptScrollPosition): number {
  return Math.max(0, position.scrollHeight - position.clientHeight - position.scrollTop);
}

export function shouldFollowTranscript(position: TranscriptScrollPosition): boolean {
  return transcriptDistanceFromBottom(position) <= TRANSCRIPT_AT_BOTTOM_PX;
}

/**
 * `false` must be passed to Virtuoso while detached. A callback that merely
 * returns false still leaves its row-resize and viewport-resize follow paths on.
 */
export function transcriptFollowOutput(following: boolean): "auto" | false {
  return following ? "auto" : false;
}
