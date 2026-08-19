import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/domain/pasted_text.dart';

void main() {
  test('ordinary pastes stay in the composer field', () {
    expect(isLongPastedText(''), isFalse);
    expect(isLongPastedText('fix the login redirect'), isFalse);
    expect(isLongPastedText('x' * (pastedTextMinChars - 1)), isFalse);
    expect(isLongPastedText('line\n' * (pastedTextMinLines - 2)), isFalse);
  });

  test('a dense or a tall paste becomes an attachment', () {
    expect(isLongPastedText('x' * pastedTextMinChars), isTrue);
    // Short lines, but far taller than the composer can show.
    expect(isLongPastedText('a\n' * pastedTextMinLines), isTrue);
  });

  test('pasted text is named as a text file, uniquely per slot', () {
    expect(pastedTextName(1700000000000), 'pasted-text-1700000000000.txt');
    expect(
      pastedTextName(1700000000000, index: 2),
      'pasted-text-1700000000000-2.txt',
    );
  });
}
