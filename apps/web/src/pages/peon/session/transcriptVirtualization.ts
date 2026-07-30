export const TRANSCRIPT_VIRTUAL_INDEX_BASE = 1_000_000;

export interface KeyedTranscriptRow {
  key: string;
}

export interface TranscriptVirtualWindow<Row extends KeyedTranscriptRow> {
  sessionKey: string;
  rows: Row[];
  firstItemIndex: number;
}

export function createTranscriptVirtualWindow<Row extends KeyedTranscriptRow>(
  sessionKey: string,
  rows: Row[],
): TranscriptVirtualWindow<Row> {
  return { sessionKey, rows, firstItemIndex: TRANSCRIPT_VIRTUAL_INDEX_BASE };
}

/**
 * Virtuoso preserves a prepended viewport when firstItemIndex decreases by the
 * exact number of new rows before an existing row. Find the earliest surviving
 * row instead of assuming row zero survives: a tool result at a page boundary
 * can merge into the tool call loaded immediately before it.
 */
export function updateTranscriptVirtualWindow<Row extends KeyedTranscriptRow>(
  previous: TranscriptVirtualWindow<Row>,
  sessionKey: string,
  rows: Row[],
): TranscriptVirtualWindow<Row> {
  if (previous.sessionKey !== sessionKey) return createTranscriptVirtualWindow(sessionKey, rows);
  if (previous.rows === rows) return previous;

  const nextIndexByKey = new Map(rows.map((row, index) => [row.key, index]));
  let prependCount = 0;
  for (let previousIndex = 0; previousIndex < previous.rows.length; previousIndex += 1) {
    const nextIndex = nextIndexByKey.get(previous.rows[previousIndex]!.key);
    if (nextIndex === undefined) continue;
    prependCount = Math.max(0, nextIndex - previousIndex);
    break;
  }
  return {
    sessionKey,
    rows,
    firstItemIndex: previous.firstItemIndex - prependCount,
  };
}
