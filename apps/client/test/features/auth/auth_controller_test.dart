import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';

void main() {
  test(
    'backend unavailability preserves private data and can be retried',
    () async {
      final repository = _UnavailableThenRestoredRepository();
      var privateDataClears = 0;
      final container = ProviderContainer(
        overrides: [
          authRepositoryProvider.overrideWithValue(repository),
          sessionPrivateDataClearerProvider.overrideWithValue(() async {
            privateDataClears += 1;
          }),
        ],
      );
      addTearDown(container.dispose);

      container.read(authControllerProvider);
      await Future<void>.delayed(Duration.zero);

      expect(
        container.read(authControllerProvider).phase,
        AuthPhase.unavailable,
      );
      expect(privateDataClears, 0);

      await container.read(authControllerProvider.notifier).retryRestore();

      final state = container.read(authControllerProvider);
      expect(state.phase, AuthPhase.authenticated);
      expect(state.session?.token, 'stored.token');
      expect(privateDataClears, 0);
    },
  );
}

class _UnavailableThenRestoredRepository implements AuthRepository {
  var restoreCalls = 0;

  @override
  Future<AuthSession?> restore() async {
    restoreCalls += 1;
    if (restoreCalls == 1) {
      throw const RemoteAuthException(
        statusCode: 503,
        code: 'UNAVAILABLE',
        message: 'Could not reach Overseer.',
      );
    }
    return const AuthSession(
      token: 'stored.token',
      user: OperatorIdentity(email: 'operator@example.com'),
    );
  }

  @override
  Future<AuthSession> signIn() => throw UnimplementedError();

  @override
  Future<void> signOut() => throw UnimplementedError();
}
