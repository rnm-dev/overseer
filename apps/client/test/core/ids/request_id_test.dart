import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/ids/request_id.dart';

void main() {
  test('mints distinct RFC 4122 version 4 UUIDs', () {
    final pattern = RegExp(
      r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    );
    final ids = List.generate(32, (_) => newRequestId());
    expect(ids, everyElement(matches(pattern)));
    expect(ids.toSet(), hasLength(ids.length));
  });
}
