import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/presentation/server_setup_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_text_field.dart';

void main() {
  Widget subject(Future<void> Function(Uri) onContinue) {
    return MaterialApp(
      theme: AppTheme.dark,
      home: ServerSetupPage(
        initialUrl: '',
        onContinue: onContinue,
        logo: const SizedBox(
          key: Key('test-overseer-logo'),
          width: 220,
          height: 220,
        ),
      ),
    );
  }

  testWidgets('uses app form controls and submits a normalized URL', (
    WidgetTester tester,
  ) async {
    Uri? submitted;
    await tester.pumpWidget(
      subject((serverUrl) async {
        submitted = serverUrl;
      }),
    );

    expect(find.byType(AppTextField), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const Key('server-setup-continue')),
        matching: find.text('Add Overseer'),
      ),
      findsOneWidget,
    );
    expect(find.text('Sign In'), findsNothing);

    await tester.enterText(
      find.byType(TextField),
      ' https://overseer.example/ ',
    );
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();

    expect(submitted, Uri.parse('https://overseer.example'));
  });

  testWidgets('keeps the user on the form when the URL is invalid', (
    WidgetTester tester,
  ) async {
    var submissions = 0;
    await tester.pumpWidget(
      subject((_) async {
        submissions += 1;
      }),
    );

    await tester.enterText(find.byType(TextField), 'overseer.example');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();

    expect(submissions, 0);
    expect(find.text('Enter a valid http:// or https:// URL.'), findsOneWidget);
  });

  testWidgets('reports persistence failures and enables retry', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      subject((_) => Future<void>.error(StateError('write failed'))),
    );

    await tester.enterText(find.byType(TextField), 'https://overseer.example');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();
    await tester.pump();

    expect(
      find.text('The Overseer URL could not be saved. Please try again.'),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('server-setup-continue')),
        matching: find.text('Add Overseer'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('presents a specific duplicate connection error', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      subject(
        (_) => Future<void>.error(const DuplicateOverseerConnectionException()),
      ),
    );

    await tester.enterText(find.byType(TextField), 'https://overseer.example');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();
    await tester.pump();

    expect(
      find.text('This Overseer connection is already saved.'),
      findsOneWidget,
    );
  });
}
