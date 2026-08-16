import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  Widget subject({
    required VoidCallback onSignIn,
    bool isSigningIn = false,
    String? errorMessage,
    VoidCallback? onBack,
  }) {
    return MaterialApp(
      theme: AppTheme.dark,
      home: SignInPage(
        onSignIn: onSignIn,
        isSigningIn: isSigningIn,
        errorMessage: errorMessage,
        onBack: onBack,
      ),
    );
  }

  testWidgets('shows a plain sign-in page and starts GitHub sign in', (
    WidgetTester tester,
  ) async {
    var attempts = 0;

    await tester.pumpWidget(subject(onSignIn: () => attempts++));

    expect(find.byType(Image), findsNothing);
    expect(find.text('Sign in to Overseer'), findsOneWidget);
    expect(find.text('Sign In'), findsOneWidget);

    final button = find.byKey(const Key('github-sign-in-button'));
    expect(tester.getSize(button).width, lessThanOrEqualTo(520));
    expect(
      tester.getCenter(button).dx,
      tester.getCenter(find.byType(Scaffold)).dx,
    );

    await tester.tap(button);

    expect(attempts, 1);
  });

  testWidgets('returns to the Overseer list', (WidgetTester tester) async {
    var backCalls = 0;
    await tester.pumpWidget(
      subject(onSignIn: () {}, onBack: () => backCalls += 1),
    );

    await tester.tap(find.byKey(const Key('auth-back-to-connections')));

    expect(backCalls, 1);
    expect(find.byTooltip('Back to Overseers'), findsOneWidget);
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
