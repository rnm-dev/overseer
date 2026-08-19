/// A pasted wall of text — a log, a stack trace, a whole document — buries the
/// instruction that was supposed to go with it. Past a threshold the composer
/// captures it as a text attachment instead, leaving the input for the message.
///
/// The thresholds match the web composer's (`apps/web/src/features/sessions/
/// pastedText.ts`) so the same paste behaves the same on both surfaces.
const int pastedTextMinChars = 2000;
const int pastedTextMinLines = 50;

bool isLongPastedText(String text) {
  if (text.length >= pastedTextMinChars) return true;
  // A tall paste is just as unreadable in a 160px-high field as a dense one.
  return '\n'.allMatches(text).length + 1 >= pastedTextMinLines;
}

/// Named so the composer chip and the agent both see it for what it is. The
/// timestamp keeps two pastes in one message from colliding on upload, and the
/// index keeps them apart when the clock does not move between them.
String pastedTextName(int millisecondsSinceEpoch, {int index = 0}) {
  final suffix = index > 0 ? '-$index' : '';
  return 'pasted-text-$millisecondsSinceEpoch$suffix.txt';
}
