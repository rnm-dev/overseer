import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';

final authRepositoryProvider = Provider<AuthRepository>(
  (ref) => throw StateError(
    'AuthRepository must be supplied by the application composition root.',
  ),
);

typedef SessionPrivateDataClearer = Future<void> Function();

final sessionPrivateDataClearerProvider = Provider<SessionPrivateDataClearer>(
  (ref) => () async {},
);

final authControllerProvider = NotifierProvider<AuthController, AuthState>(
  AuthController.new,
);

class AuthController extends Notifier<AuthState> {
  @override
  AuthState build() {
    unawaited(Future<void>.microtask(_restore));
    return const AuthState.restoring();
  }

  Future<void> _restore() async {
    try {
      final session = await ref.read(authRepositoryProvider).restore();
      if (session == null) {
        await ref.read(sessionPrivateDataClearerProvider)();
      }
      state = session == null
          ? const AuthState.unauthenticated()
          : AuthState.authenticated(session);
    } catch (error) {
      state = AuthState.unavailable(errorMessage: _message(error));
    }
  }

  Future<void> retryRestore() async {
    if (state.phase == AuthPhase.restoring) return;
    state = const AuthState.restoring();
    await _restore();
  }

  Future<void> signIn() async {
    if (state.phase == AuthPhase.signingIn) return;
    state = const AuthState.signingIn();
    try {
      final session = await ref.read(authRepositoryProvider).signIn();
      await ref.read(sessionPrivateDataClearerProvider)();
      state = AuthState.authenticated(session);
    } catch (error) {
      state = AuthState.unauthenticated(errorMessage: _message(error));
    }
  }

  Future<void> signOut() async {
    try {
      await ref.read(authRepositoryProvider).signOut();
    } finally {
      await ref.read(sessionPrivateDataClearerProvider)();
      state = const AuthState.unauthenticated();
    }
  }

  String _message(Object error) {
    if (error is AuthException) return error.message;
    return 'Sign-in could not be completed. Please try again.';
  }
}
