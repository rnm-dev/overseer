// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Russian (`ru`).
class AppLocalizationsRu extends AppLocalizations {
  AppLocalizationsRu([String locale = 'ru']) : super(locale);

  @override
  String get appTitle => 'Overseer';

  @override
  String get loadingOverseerConnections => 'Загрузка подключений Overseer';

  @override
  String get overseerConnections => 'Подключения Overseer';

  @override
  String get addOverseerToStart => 'Добавьте сервер Overseer, чтобы начать.';

  @override
  String get chooseOverseer => 'Выберите Overseer, чтобы продолжить.';

  @override
  String get addOverseer => 'Добавить Overseer';

  @override
  String get delete => 'Удалить';

  @override
  String get deleteOverseerQuestion => 'Удалить Overseer?';

  @override
  String deleteOverseerMessage(String title) {
    return 'Удалить $title и сохранённые данные входа с этого устройства?';
  }

  @override
  String get deleteOverseer => 'Удалить Overseer';

  @override
  String get overseerDeleteFailed =>
      'Не удалось удалить Overseer. Попробуйте ещё раз.';

  @override
  String get openOverseerHint =>
      'Открыть этот Overseer. Удерживайте для действий.';

  @override
  String get overseerActions => 'Действия с Overseer';

  @override
  String get noConnections => 'Подключений пока нет';

  @override
  String get savedServersAppearHere =>
      'Здесь появятся сохранённые серверы Overseer.';

  @override
  String get addOverseerTitle => 'Добавить Overseer';

  @override
  String get overseerUrl => 'URL Overseer';

  @override
  String get overseerUrlHint => 'https://overseer.example';

  @override
  String get overseerUrlHelper => 'Адрес сохранится после успешного входа.';

  @override
  String get invalidOverseerUrl =>
      'Введите корректный URL с http:// или https://.';

  @override
  String get duplicateOverseerConnection =>
      'Это подключение Overseer уже сохранено.';

  @override
  String get overseerUrlOpenFailed =>
      'Не удалось открыть URL Overseer. Попробуйте ещё раз.';

  @override
  String get checkingSignIn => 'Проверяем вход…';

  @override
  String get continueLabel => 'Продолжить';

  @override
  String get backToOverseers => 'Назад к Overseer';

  @override
  String get signInTitle => 'Вход в Overseer';

  @override
  String get signInSubtitle =>
      'Войдите через GitHub, чтобы открыть рабочие пространства.';

  @override
  String get connecting => 'Подключаемся…';

  @override
  String get signIn => 'Войти';

  @override
  String get backendUnavailableTitle => 'Overseer недоступен';

  @override
  String get backendUnavailableMessage =>
      'Не удалось связаться с сервером. Вы по-прежнему авторизованы — повторите попытку, когда соединение восстановится.';

  @override
  String get tryAgain => 'Повторить';

  @override
  String get message => 'Сообщение';

  @override
  String get sendMessageHint => 'Напишите сообщение…';

  @override
  String get attachFiles => 'Прикрепить файлы';

  @override
  String get steer => 'Направить';

  @override
  String get queue => 'В очередь';

  @override
  String get send => 'Отправить';

  @override
  String queuedMessages(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count сообщения ожидают отправки',
      many: '$count сообщений ожидают отправки',
      few: '$count сообщения ожидают отправки',
      one: '$count сообщение ожидает отправки',
    );
    return '$_temp0';
  }

  @override
  String get toolActivityRead => 'Открыт файл';

  @override
  String get toolActivitySearch => 'Выполнен поиск по материалам';

  @override
  String get toolActivityWeb => 'Проверены внешние источники';

  @override
  String get toolActivityEdit => 'Изменён файл';

  @override
  String get toolActivityAnalysis => 'Проведён дополнительный анализ';

  @override
  String get toolActivityCommand => 'Выполнена техническая операция';

  @override
  String get toolActivityGeneric => 'Выполнено действие';

  @override
  String get toolActivityFailedShort => 'ошибка';

  @override
  String get showTechnicalDetails => 'Показать технические детали';
}
