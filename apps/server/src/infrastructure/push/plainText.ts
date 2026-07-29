// A notification is a single line of system UI, not a document: iOS and Android
// render the title and body as plain text, so `**ship it**` arrives with its
// asterisks and a fenced code block arrives as backtick soup. Session titles and
// previews are Markdown by origin — they are the model's and the user's own
// prose — so they get flattened on the way out.
//
// This is deliberately a flattener, not a parser. It removes the syntax that
// survives into a phone's lock screen and leaves everything ambiguous alone: an
// underscore inside snake_case, a lone asterisk, a `<` between two numbers.

export function plainText(value: string): string {
  return value
    // Fenced blocks lose the fence, not the code — the first line of a snippet
    // is often the most informative thing a preview has.
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ""))
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // Not anchored to a line start: previews reach the index already flattened
    // into one line, so a heading marker usually turns up mid-sentence. The
    // required trailing space is what keeps "issue #123" intact.
    .replace(/(^|\s)#{1,6}\s+/gm, "$1")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    // Emphasis only where a word does not continue through the marker, so
    // file_name_here and 3 * 4 survive intact.
    .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    // Every newline becomes a space: the OS collapses them anyway, and doing it
    // here keeps the two-line preview from turning into one word per line.
    .replace(/\s+/g, " ")
    .trim();
}
