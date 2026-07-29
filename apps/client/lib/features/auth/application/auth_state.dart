import 'package:flutter/foundation.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';

enum AuthPhase { restoring, unauthenticated, signingIn, authenticated }

@immutable
class AuthState {
  const AuthState._({required this.phase, this.session, this.errorMessage});

  const AuthState.restoring() : this._(phase: AuthPhase.restoring);

  const AuthState.unauthenticated({String? errorMessage})
    : this._(phase: AuthPhase.unauthenticated, errorMessage: errorMessage);

  const AuthState.signingIn() : this._(phase: AuthPhase.signingIn);

  const AuthState.authenticated(AuthSession session)
    : this._(phase: AuthPhase.authenticated, session: session);

  final AuthPhase phase;
  final AuthSession? session;
  final String? errorMessage;
}
