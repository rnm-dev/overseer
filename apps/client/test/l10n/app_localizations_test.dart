import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/auth/presentation/sign_in_page.dart';
import 'package:overseer_mobile/l10n/l10n.dart';

void main() {
  testWidgets('renders the sign-in surface in Russian', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('ru'),
        localizationsDelegates: const [
          AppLocalizations.delegate,
          GlobalMaterialLocalizations.delegate,
          GlobalWidgetsLocalizations.delegate,
          GlobalCupertinoLocalizations.delegate,
        ],
        supportedLocales: AppLocalizations.supportedLocales,
        home: const SignInPage(onSignIn: null),
      ),
    );

    expect(find.text('Вход в Overseer'), findsOneWidget);
    expect(find.text('Войти'), findsOneWidget);
  });

  test('Russian plural forms cover queued messages', () {
    final l10n = lookupAppLocalizations(const Locale('ru'));

    expect(l10n.queuedMessages(1), '1 сообщение ожидает отправки');
    expect(l10n.queuedMessages(2), '2 сообщения ожидают отправки');
    expect(l10n.queuedMessages(5), '5 сообщений ожидают отправки');
  });

  test('unsupported device languages fall back to English', () {
    final resolved = basicLocaleListResolution(const [
      Locale('kk'),
    ], AppLocalizations.supportedLocales);

    expect(resolved, const Locale('en'));
  });
}
