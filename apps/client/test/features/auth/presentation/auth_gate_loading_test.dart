import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_gate.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/features/shell/shell.dart';

Widget _buildAuthGateLoading({
  required String? overseerName,
  required VoidCallback? onBackToConnections,
}) => ShellPage.loading(
  overseerName: overseerName,
  onBackToConnections: onBackToConnections,
);

Widget _buildAuthGateSignIn({
  required Future<void> Function() onSignIn,
  String? errorMessage,
  required bool isSigningIn,
  VoidCallback? onBack,
}) => SignInPage(
  onSignIn: onSignIn,
  errorMessage: errorMessage,
  isSigningIn: isSigningIn,
  onBack: onBack,
);

Widget _buildAuthGateShell({
  required OperatorIdentity user,
  required Future<void> Function() onSignOut,
  String? overseerName,
  VoidCallback? onBackToConnections,
}) => ShellPage(
  user: user,
  onSignOut: onSignOut,
  overseerName: overseerName,
  onBackToConnections: onBackToConnections,
);

void main() {
  testWidgets('shows the Overseer index while the session is restored', (
    WidgetTester tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.binding.setSurfaceSize(const Size(390, 844));
    final repository = _PendingAuthRepository();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          sessionPrivateDataClearerProvider.overrideWithValue(() async {}),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const AuthGate(
            overseerName: 'overseer.example',
            buildLoading: _buildAuthGateLoading,
            buildSignIn: _buildAuthGateSignIn,
            buildShell: _buildAuthGateShell,
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('compact-shell')), findsOneWidget);
    expect(find.byKey(const Key('overseer-index-navbar')), findsOneWidget);
    expect(find.text('overseer.example'), findsOneWidget);
    expect(find.byKey(const Key('fleet-loading')), findsOneWidget);
    expect(find.byKey(const Key('settings-loading')), findsOneWidget);
    expect(find.byKey(const Key('auth-restoring-logo')), findsNothing);
    expect(find.byKey(const Key('auth-restoring-progress')), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);

    repository.complete();
    await tester.pump();
  });

  testWidgets('restoring index can return to the Overseer list', (
    WidgetTester tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.binding.setSurfaceSize(const Size(390, 844));
    var backCalls = 0;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(_PendingAuthRepository()),
          sessionPrivateDataClearerProvider.overrideWithValue(() async {}),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: AuthGate(
            onBack: () => backCalls += 1,
            buildLoading: _buildAuthGateLoading,
            buildSignIn: _buildAuthGateSignIn,
            buildShell: _buildAuthGateShell,
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('back-to-overseer-list')));

    expect(backCalls, 1);
    expect(find.byTooltip('Back to Overseer list'), findsOneWidget);
  });

  testWidgets('system back returns to the Overseer list', (
    WidgetTester tester,
  ) async {
    var backCalls = 0;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(_PendingAuthRepository()),
          sessionPrivateDataClearerProvider.overrideWithValue(() async {}),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: AuthGate(
            onBack: () => backCalls += 1,
            buildLoading: _buildAuthGateLoading,
            buildSignIn: _buildAuthGateSignIn,
            buildShell: _buildAuthGateShell,
          ),
        ),
      ),
    );

    final handled = await tester.binding.handlePopRoute();
    await tester.pump();

    expect(handled, isTrue);
    expect(backCalls, 1);
    expect(find.byType(AuthGate), findsOneWidget);
  });

  testWidgets('auto sign-in launches without showing the sign-in screen', (
    WidgetTester tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.binding.setSurfaceSize(const Size(390, 844));
    final repository = _AutoSignInRepository();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          sessionPrivateDataClearerProvider.overrideWithValue(() async {}),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const AuthGate(
            autoSignIn: true,
            buildLoading: _buildAuthGateLoading,
            buildSignIn: _buildAuthGateSignIn,
            buildShell: _buildAuthGateShell,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(repository.signInCalls, 1);
    expect(find.text('Sign In'), findsNothing);
    expect(find.byKey(const Key('compact-shell')), findsOneWidget);
    expect(find.byKey(const Key('fleet-loading')), findsOneWidget);
    expect(find.byKey(const Key('auth-restoring-logo')), findsNothing);
  });

  testWidgets('auto sign-in shows retry UI after an authentication error', (
    WidgetTester tester,
  ) async {
    final repository = _FailingAutoSignInRepository();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          sessionPrivateDataClearerProvider.overrideWithValue(() async {}),
        ],
        child: MaterialApp(
          theme: AppTheme.dark,
          home: const AuthGate(
            autoSignIn: true,
            buildLoading: _buildAuthGateLoading,
            buildSignIn: _buildAuthGateSignIn,
            buildShell: _buildAuthGateShell,
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump();
    await tester.pump();

    expect(repository.signInCalls, 1);
    expect(find.text('Sign In'), findsOneWidget);
    expect(find.text('The login was cancelled.'), findsOneWidget);
  });
}

class _PendingAuthRepository implements AuthRepository {
  final Completer<AuthSession?> _restore = Completer<AuthSession?>();

  void complete() => _restore.complete(null);

  @override
  Future<AuthSession?> restore() => _restore.future;

  @override
  Future<AuthSession> signIn() =>
      throw UnimplementedError('Sign-in is not used by this widget test.');

  @override
  Future<void> signOut() async {}
}

class _AutoSignInRepository implements AuthRepository {
  final Completer<AuthSession> _signIn = Completer<AuthSession>();
  int signInCalls = 0;

  @override
  Future<AuthSession?> restore() async => null;

  @override
  Future<AuthSession> signIn() {
    signInCalls += 1;
    return _signIn.future;
  }

  @override
  Future<void> signOut() async {}
}

class _FailingAutoSignInRepository implements AuthRepository {
  int signInCalls = 0;

  @override
  Future<AuthSession?> restore() async => null;

  @override
  Future<AuthSession> signIn() async {
    signInCalls += 1;
    throw const AuthException('The login was cancelled.');
  }

  @override
  Future<void> signOut() async {}
}
