import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/shell/shell.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets(
    'lists saved Overseers, switches only to another server, and opens management',
    (tester) async {
      final current = OverseerConnection(
        serverUrl: Uri.parse('https://overseer.rnm.dev'),
      );
      final second = OverseerConnection(
        serverUrl: Uri.parse('https://other.example:8443'),
      );
      OverseerConnection? selected;
      var managed = false;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SizedBox(
                width: 220,
                child: OverseerSwitcher(
                  data: OverseerSwitcherData(
                    connections: [current, second],
                    current: current,
                    onSelect: (connection) => selected = connection,
                    onManage: () => managed = true,
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.byKey(const Key('overseer-switcher')));
      await tester.pumpAndSettle();
      expect(find.text(second.id), findsOneWidget);
      await tester.tap(find.text(current.id));
      await tester.pumpAndSettle();
      expect(selected, isNull);
      await tester.tap(find.byKey(const Key('overseer-switcher')));
      await tester.pumpAndSettle();
      await tester.tap(find.text(second.id));
      await tester.pumpAndSettle();
      expect(selected, same(second));
      await tester.tap(find.byKey(const Key('overseer-switcher')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Add or manage Overseers'));
      await tester.pumpAndSettle();
      expect(managed, isTrue);
      expect(tester.takeException(), isNull);
    },
  );
}
