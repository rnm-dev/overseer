import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/presentation/voice_input_alert_sheet.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets('offers system settings for permanently blocked access', (
    tester,
  ) async {
    var openedSettings = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => unawaited(
                showVoiceInputAlertSheet(
                  context: context,
                  message:
                      'Microphone access is blocked. '
                      'Enable it in system settings.',
                  canOpenSettings: true,
                  openSettings: () async {
                    openedSettings = true;
                    return true;
                  },
                ),
              ),
              child: const Text('Show'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(find.text('Voice input'), findsOneWidget);
    expect(find.byKey(const Key('voice-input-alert-message')), findsOneWidget);
    expect(find.byKey(const Key('voice-input-open-settings')), findsOneWidget);
    expect(find.text('Not now'), findsOneWidget);

    await tester.tap(find.byKey(const Key('voice-input-open-settings')));
    await tester.pumpAndSettle();
    expect(openedSettings, isTrue);
    expect(find.byKey(const Key('voice-input-alert-message')), findsNothing);
  });

  testWidgets('uses a single acknowledgement action for other voice errors', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Builder(
          builder: (context) => Scaffold(
            body: TextButton(
              onPressed: () => unawaited(
                showVoiceInputAlertSheet(
                  context: context,
                  message: 'No speech was detected.',
                  canOpenSettings: false,
                  openSettings: () async => false,
                ),
              ),
              child: const Text('Show'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Show'));
    await tester.pumpAndSettle();

    expect(find.text('No speech was detected.'), findsOneWidget);
    expect(find.byKey(const Key('voice-input-open-settings')), findsNothing);
    expect(find.text('OK'), findsOneWidget);
  });
}
