import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/presentation/overseer_connections_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/entity_list_tile.dart';

void main() {
  Widget subject({
    List<OverseerConnection> connections = const <OverseerConnection>[],
    VoidCallback? onAdd,
    ValueChanged<OverseerConnection>? onSelect,
  }) {
    return MaterialApp(
      theme: AppTheme.dark,
      home: OverseerConnectionsPage(
        connections: connections,
        onAdd: onAdd ?? () {},
        onSelect: onSelect ?? (_) {},
        logo: const SizedBox(width: 180, height: 180),
      ),
    );
  }

  testWidgets('shows an add action in the empty state', (
    WidgetTester tester,
  ) async {
    var additions = 0;
    await tester.pumpWidget(subject(onAdd: () => additions += 1));

    expect(find.text('No connections yet'), findsOneWidget);
    expect(find.byType(EntityListTile), findsNothing);
    expect(find.byType(AppButton), findsOneWidget);

    await tester.tap(find.text('Add Overseer'));
    expect(additions, 1);
  });

  testWidgets('renders and selects saved connections', (
    WidgetTester tester,
  ) async {
    final first = OverseerConnection(
      serverUrl: Uri.parse('https://one.example'),
    );
    final second = OverseerConnection(
      serverUrl: Uri.parse('http://two.example:3000'),
    );
    OverseerConnection? selected;

    await tester.pumpWidget(
      subject(
        connections: <OverseerConnection>[first, second],
        onSelect: (connection) => selected = connection,
      ),
    );

    expect(find.byType(EntityListTile), findsNWidgets(2));
    expect(find.text('https://one.example'), findsOneWidget);
    expect(find.text('http://two.example:3000'), findsOneWidget);

    await tester.tap(find.text('one.example'));
    expect(selected, same(first));
  });
}
