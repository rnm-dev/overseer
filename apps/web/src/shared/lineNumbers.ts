// The gutter is one text node rather than an element per line: it scrolls,
// wraps and aligns with the code beside it for free, and a file of ten
// thousand lines costs one string instead of ten thousand nodes.

export function countLines(source: string): number {
  if (source === "") return 1;
  // A file ending in a newline does not have an empty last line to number —
  // an editor showing `3` for a three-line file that ends in \n is right.
  const trailing = source.endsWith("\n") ? 1 : 0;
  return source.split("\n").length - trailing;
}

export function lineNumberText(source: string): string {
  const total = countLines(source);
  let text = "1";
  for (let line = 2; line <= total; line++) text = `${text}\n${line}`;
  return text;
}

// The gutter has to be wide enough for the longest number it will ever show
// while the operator types, so it is sized in characters, not measured.
export const gutterWidthCh = (source: string): number => Math.max(2, String(countLines(source)).length);
