import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_gate.dart';
import 'package:overseer_mobile/features/auth/presentation/auth_restoring_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets('continues the splash while the session is restored', (
    WidgetTester tester,
  ) async {
    final repository = _PendingAuthRepository();

    await tester.pumpWidget(
      ProviderScope(
        overrides: [authRepositoryProvider.overrideWithValue(repository)],
        child: MaterialApp(theme: AppTheme.dark, home: const AuthGate()),
      ),
    );

    final scaffold = find.byType(Scaffold);
    final logo = find.byKey(const Key('auth-restoring-logo'));
    final progress = find.byKey(const Key('auth-restoring-progress'));

    expect(logo, findsOneWidget);
    expect(progress, findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(
      tester.getSize(logo),
      const Size.square(AuthRestoringPage.logoExtent),
    );
    expect(tester.getCenter(logo), tester.getCenter(scaffold));
    expect(
      tester.getCenter(progress).dy - tester.getCenter(logo).dy,
      AuthRestoringPage.progressOffset,
    );

    repository.complete();
    await tester.pump();
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
