import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

void main() {
  Widget subject({
    required VoidCallback onSignIn,
    bool isSigningIn = false,
    String? errorMessage,
  }) {
    return MaterialApp(
      theme: AppTheme.dark,
      home: SignInPage(
        onSignIn: onSignIn,
        isSigningIn: isSigningIn,
        errorMessage: errorMessage,
        logo: const SizedBox(
          key: Key('test-overseer-logo'),
          width: 220,
          height: 220,
        ),
      ),
    );
  }

  testWidgets('shows the logo and starts GitHub sign in', (
    WidgetTester tester,
  ) async {
    var attempts = 0;

    await tester.pumpWidget(subject(onSignIn: () => attempts++));

    expect(find.byKey(const Key('test-overseer-logo')), findsOneWidget);
    expect(find.byKey(const Key('sign-in-hero')), findsOneWidget);
    expect(find.text('Sign In'), findsOneWidget);

    final button = find.byKey(const Key('github-sign-in-button'));
    expect(tester.getSize(button).width, greaterThan(700));
    expect(
      tester.getCenter(button).dx,
      tester.getCenter(find.byType(Scaffold)).dx,
    );

    await tester.tap(button);

    expect(attempts, 1);
  });

  testWidgets('default logo matches the native splash size', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: SignInPage(onSignIn: () {}),
      ),
    );

    expect(
      tester.getSize(find.byType(OverseerLogo)),
      const Size.square(OverseerLogo.splashExtent),
    );
  });

  testWidgets('shows a protected loading state', (WidgetTester tester) async {
    var attempts = 0;

    await tester.pumpWidget(
      subject(onSignIn: () => attempts++, isSigningIn: true),
    );

    expect(find.text('Connecting…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await tester.tap(find.byKey(const Key('github-sign-in-button')));

    expect(attempts, 0);
  });

  testWidgets('presents authentication errors', (WidgetTester tester) async {
    await tester.pumpWidget(
      subject(
        onSignIn: () {},
        errorMessage: 'GitHub did not return a sign-in code.',
      ),
    );

    expect(find.byKey(const Key('sign-in-error')), findsOneWidget);
    expect(find.text('GitHub did not return a sign-in code.'), findsOneWidget);
  });
}
