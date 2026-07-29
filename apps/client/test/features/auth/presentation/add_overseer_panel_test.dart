import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/presentation/add_overseer_panel.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_text_field.dart';

void main() {
  Widget subject(Future<void> Function(Uri) onContinue) {
    return MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: Column(
          children: [
            const Expanded(child: SizedBox()),
            AddOverseerPanel(onContinue: onContinue),
          ],
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
    expect(find.text('Add Overseer'), findsOneWidget);
    expect(find.text('Continue'), findsOneWidget);
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

  testWidgets('reports opening failures and enables retry', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      subject((_) => Future<void>.error(StateError('open failed'))),
    );

    await tester.enterText(find.byType(TextField), 'https://overseer.example');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();
    await tester.pump();

    expect(
      find.text('The Overseer URL could not be opened. Please try again.'),
      findsOneWidget,
    );
    expect(find.text('Continue'), findsOneWidget);
  });

  testWidgets('shows the provisional authentication error on the form', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      subject(
        (_) => Future<void>.error(const AuthException('Sign-in was canceled.')),
      ),
    );

    await tester.enterText(find.byType(TextField), 'https://overseer.example');
    await tester.tap(find.byKey(const Key('server-setup-continue')));
    await tester.pump();
    await tester.pump();

    expect(find.text('Sign-in was canceled.'), findsOneWidget);
    expect(find.text('Continue'), findsOneWidget);
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
