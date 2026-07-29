String? formatActivityTimestamp(double? raw, {DateTime? now}) {
  if (raw == null || raw <= 0) return null;

  final milliseconds = raw < 100000000000 ? (raw * 1000).round() : raw.round();
  final date = DateTime.fromMillisecondsSinceEpoch(milliseconds).toLocal();
  final reference = (now ?? DateTime.now()).toLocal();
  final time = '${_twoDigits(date.hour)}:${_twoDigits(date.minute)}';

  if (_sameDay(date, reference)) return time;

  final yesterday = DateTime(
    reference.year,
    reference.month,
    reference.day - 1,
  );
  if (_sameDay(date, yesterday)) return 'yesterday, $time';

  return '${_twoDigits(date.day)}.${_twoDigits(date.month)}.${date.year}, $time';
}

String _twoDigits(int value) => value.toString().padLeft(2, '0');

bool _sameDay(DateTime left, DateTime right) =>
    left.year == right.year &&
    left.month == right.month &&
    left.day == right.day;
