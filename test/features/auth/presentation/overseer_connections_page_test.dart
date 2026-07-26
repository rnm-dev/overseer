import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/presentation/overseer_connections_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/entity_list_tile.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

void main() {
  Widget subject({
    List<OverseerConnection> connections = const <OverseerConnection>[],
    Future<void> Function(Uri)? onAdd,
    ValueChanged<OverseerConnection>? onSelect,
    Future<void> Function(OverseerConnection)? onDelete,
  }) {
    return MaterialApp(
      theme: AppTheme.dark,
      home: OverseerConnectionsPage(
        connections: connections,
        onAdd: onAdd ?? (_) async {},
        onSelect: onSelect ?? (_) {},
        onDelete: onDelete ?? (_) async {},
      ),
    );
  }

  testWidgets('opens the add form as a modal sheet from the empty state', (
    WidgetTester tester,
  ) async {
    Uri? added;
    await tester.pumpWidget(
      subject(onAdd: (serverUrl) async => added = serverUrl),
    );

    expect(find.byType(OverseerLogo), findsNothing);
    expect(find.byType(Image), findsNothing);
    expect(find.text('No connections yet'), findsOneWidget);
    expect(find.byType(EntityListTile), findsNothing);
    expect(find.byType(AppButton), findsOneWidget);
    expect(find.byKey(const Key('add-overseer-panel-handle')), findsNothing);
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.byKey(const Key('empty-add-overseer-button')));
    await tester.pumpAndSettle();

    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byKey(const Key('add-overseer-panel-handle')), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'https://overseer.example/');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();

    expect(added, Uri.parse('https://overseer.example'));
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
    expect(find.byIcon(LucideIcons.chevronRight), findsNothing);
    expect(find.byIcon(LucideIcons.trash2), findsNothing);
    expect(find.text('Add Overseer'), findsOneWidget);
    expect(find.byType(TextField), findsNothing);

    await tester.tap(find.text('one.example'));
    expect(selected, same(first));
  });

  testWidgets('long press confirms and deletes a saved connection', (
    WidgetTester tester,
  ) async {
    final connection = OverseerConnection(
      serverUrl: Uri.parse('https://one.example'),
    );
    OverseerConnection? deleted;

    await tester.pumpWidget(
      subject(
        connections: <OverseerConnection>[connection],
        onDelete: (connection) async => deleted = connection,
      ),
    );

    await tester.longPress(
      find.byKey(const ValueKey('overseer-connection-https://one.example')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Overseer actions'), findsOneWidget);
    expect(find.byKey(const Key('overseer-menu-delete')), findsOneWidget);

    await tester.tap(find.byKey(const Key('overseer-menu-delete')));
    await tester.pumpAndSettle();
    expect(find.text('Delete Overseer?'), findsOneWidget);

    await tester.tap(find.byKey(const Key('confirmation-confirm')));
    await tester.pumpAndSettle();

    expect(deleted, same(connection));
  });

  testWidgets('long press uses a contextual menu on wide layouts', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = OverseerConnection(
      serverUrl: Uri.parse('https://one.example'),
    );

    await tester.pumpWidget(
      subject(connections: <OverseerConnection>[connection]),
    );
    await tester.longPress(
      find.byKey(const ValueKey('overseer-connection-https://one.example')),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('overseer-menu-delete')), findsOneWidget);
    expect(find.byType(BottomSheet), findsNothing);
  });
}
