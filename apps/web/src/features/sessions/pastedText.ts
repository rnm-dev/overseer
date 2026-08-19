// author: Viktor
// A pasted wall of text — a log, a stack trace, a whole document — buries the
// instruction that was supposed to go with it. Past a threshold the composer
// captures it as a text attachment instead, leaving the input for the message.

export const PASTED_TEXT_MIN_CHARS = 2000;
export const PASTED_TEXT_MIN_LINES = 50;

export function isLongPastedText(text: string): boolean {
  if (text.length >= PASTED_TEXT_MIN_CHARS) return true;
  // A tall paste is just as unreadable in a 10rem textarea as a dense one.
  return text.split("\n").length >= PASTED_TEXT_MIN_LINES;
}

// Named so the composer chip and the agent both see it for what it is. The
// timestamp keeps two pastes in one message from colliding on upload.
export function pastedTextFile(text: string, at: number, index = 0): File {
  const suffix = index > 0 ? `-${index}` : "";
  return new File([text], `pasted-text-${at}${suffix}.txt`, { type: "text/plain" });
}

export function isPastedTextName(name: string): boolean {
  return /^pasted-text-\d+(-\d+)?\.txt$/.test(name);
}
