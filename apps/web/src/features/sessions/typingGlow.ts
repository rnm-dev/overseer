// Freshly typed composer characters can glow and cool down. The textarea keeps
// owning the text; these helpers only track where recent insertions sit so a
// transparent mirror overlay can render just those characters.

export interface GlowRange {
  id: number;
  start: number;
  length: number;
}

export interface TextEdit {
  start: number;
  removed: number;
  inserted: number;
}

// Longer insertions (pastes, programmatic resets) are not "typing".
export const MAX_GLOW_INSERTION = 200;
export const GLOW_LIFETIME_MS = 1_000;

export function diffText(previous: string, next: string): TextEdit {
  let start = 0;
  const shortest = Math.min(previous.length, next.length);
  while (start < shortest && previous[start] === next[start]) start += 1;
  let suffix = 0;
  while (
    suffix < shortest - start
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;
  return { start, removed: previous.length - start - suffix, inserted: next.length - start - suffix };
}

// Moves existing glows past an edit; glows that touch removed text are dropped.
export function shiftGlowRanges(ranges: GlowRange[], edit: TextEdit): GlowRange[] {
  const removedEnd = edit.start + edit.removed;
  const delta = edit.inserted - edit.removed;
  return ranges.flatMap((range) => {
    const end = range.start + range.length;
    if (end <= edit.start) return [range];
    if (range.start >= removedEnd) return [{ ...range, start: range.start + delta }];
    return [];
  });
}

export function glowSegments(value: string, ranges: GlowRange[]): Array<{ text: string; glowId?: number }> {
  const segments: Array<{ text: string; glowId?: number }> = [];
  let cursor = 0;
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    if (range.start < cursor || range.start + range.length > value.length) continue;
    if (range.start > cursor) segments.push({ text: value.slice(cursor, range.start) });
    segments.push({ text: value.slice(range.start, range.start + range.length), glowId: range.id });
    cursor = range.start + range.length;
  }
  if (cursor < value.length) segments.push({ text: value.slice(cursor) });
  return segments;
}

export function typingGlowEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--ov-typing-glow").trim();
  return value !== "" && value !== "none";
}
