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
      state = session == null
          ? const AuthState.unauthenticated()
          : AuthState.authenticated(session);
    } catch (error) {
      state = AuthState.unauthenticated(errorMessage: _message(error));
    }
  }

  Future<void> signIn() async {
    if (state.phase == AuthPhase.signingIn) return;
    state = const AuthState.signingIn();
    try {
      final session = await ref.read(authRepositoryProvider).signIn();
      state = AuthState.authenticated(session);
    } catch (error) {
      state = AuthState.unauthenticated(errorMessage: _message(error));
    }
  }

  Future<void> signOut() async {
    await ref.read(authRepositoryProvider).signOut();
    state = const AuthState.unauthenticated();
  }

  String _message(Object error) {
    if (error is AuthException) return error.message;
    return 'Sign-in could not be completed. Please try again.';
  }
}
