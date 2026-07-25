import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/app/app.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/features/auth/domain/auth_repository.dart';

void main() {
  testWidgets('Overseer Mobile starts at the sign-in screen', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          authRepositoryProvider.overrideWithValue(_SignedOutRepository()),
        ],
        child: const OverseerMobileApp(),
      ),
    );
    await tester.pump();
    await tester.pump();

    expect(find.text('Sign In'), findsOneWidget);
    expect(find.bySemanticsLabel('Overseer'), findsOneWidget);
  });
}

class _SignedOutRepository implements AuthRepository {
  @override
  Future<AuthSession?> restore() async => null;

  @override
  Future<AuthSession> signIn() =>
      throw UnimplementedError('Sign-in is not used by this widget test.');

  @override
  Future<void> signOut() async {}
}
