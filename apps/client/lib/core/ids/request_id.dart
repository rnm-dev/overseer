import 'dart:math';

final Random _random = Random.secure();

/// A random RFC 4122 version 4 UUID, used as a client-generated request or
/// command id for idempotent retries.
String newRequestId() {
  final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  String hex(int start, int end) => bytes
      .sublist(start, end)
      .map((value) => value.toRadixString(16).padLeft(2, '0'))
      .join();
  return '${hex(0, 4)}-${hex(4, 6)}-${hex(6, 8)}-'
      '${hex(8, 10)}-${hex(10, 16)}';
}
