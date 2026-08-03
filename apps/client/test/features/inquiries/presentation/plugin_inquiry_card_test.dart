import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/inquiries/domain/plugin_inquiry.dart';
import 'package:overseer_mobile/features/inquiries/presentation/plugin_inquiry_card.dart';

void main() {
  for (final brightness in Brightness.values) {
    testWidgets('renders compact actionable card in $brightness theme', (
      tester,
    ) async {
      var installs = 0;
      await tester.binding.setSurfaceSize(const Size(320, 640));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: ThemeData(brightness: brightness),
          home: Scaffold(
            body: SafeArea(
              child: Align(
                alignment: Alignment.topCenter,
                child: PluginInquiryCard(
                  inquiry: _inquiry(PluginInquiryStatus.pending),
                  online: true,
                  acting: false,
                  onInstall: () => installs += 1,
                  onCancel: () {},
                ),
              ),
            ),
          ),
        ),
      );

      expect(find.text('PostHog'), findsOneWidget);
      expect(find.text('Install this managed plugin?'), findsOneWidget);
      expect(find.textContaining('inq-public'), findsNothing);
      expect(
        tester.getSize(find.byType(PluginInquiryCard)).height,
        lessThan(240),
      );
      await tester.tap(find.text('Install'));
      expect(installs, 1);
    });
  }

  testWidgets('disables both actions offline and explains recovery', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PluginInquiryCard(
            inquiry: _inquiry(PluginInquiryStatus.pending),
            online: false,
            acting: false,
            onInstall: () => fail('must stay disabled'),
            onCancel: () => fail('must stay disabled'),
          ),
        ),
      ),
    );

    expect(find.text('Reconnect to respond to this request.'), findsOneWidget);
    final buttons = tester.widgetList<TextButton>(find.byType(TextButton));
    expect(buttons.every((button) => button.onPressed == null), isTrue);
  });

  testWidgets('terminal state has no action controls', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: PluginInquiryCard(
            inquiry: _inquiry(PluginInquiryStatus.expired),
            online: true,
            acting: false,
            onInstall: () {},
            onCancel: () {},
          ),
        ),
      ),
    );

    expect(find.text('Expired'), findsOneWidget);
    expect(find.byType(TextButton), findsNothing);
  });
}

PluginInstallInquiry _inquiry(PluginInquiryStatus status) =>
    PluginInstallInquiry(
      inquiryId: 'inq-public',
      status: status,
      plugin: const PluginIdentity(
        id: 'posthog',
        name: 'posthog',
        displayName: 'PostHog',
        authPolicy: 'ON_INSTALL',
        installPolicy: 'AVAILABLE',
        installed: false,
      ),
      expiresAt: DateTime.utc(2026, 8, 4),
    );
