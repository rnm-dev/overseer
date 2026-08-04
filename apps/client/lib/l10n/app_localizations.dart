import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_en.dart';
import 'app_localizations_ru.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale)
    : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate =
      _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
        delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
      ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('en'),
    Locale('ru'),
  ];

  /// No description provided for @appTitle.
  ///
  /// In en, this message translates to:
  /// **'Overseer Mobile'**
  String get appTitle;

  /// No description provided for @loadingOverseerConnections.
  ///
  /// In en, this message translates to:
  /// **'Loading Overseer connections'**
  String get loadingOverseerConnections;

  /// No description provided for @overseerConnections.
  ///
  /// In en, this message translates to:
  /// **'Overseer connections'**
  String get overseerConnections;

  /// No description provided for @addOverseerToStart.
  ///
  /// In en, this message translates to:
  /// **'Add an Overseer server to get started.'**
  String get addOverseerToStart;

  /// No description provided for @chooseOverseer.
  ///
  /// In en, this message translates to:
  /// **'Choose an Overseer to continue.'**
  String get chooseOverseer;

  /// No description provided for @addOverseer.
  ///
  /// In en, this message translates to:
  /// **'Add Overseer'**
  String get addOverseer;

  /// No description provided for @delete.
  ///
  /// In en, this message translates to:
  /// **'Delete'**
  String get delete;

  /// No description provided for @deleteOverseerQuestion.
  ///
  /// In en, this message translates to:
  /// **'Delete Overseer?'**
  String get deleteOverseerQuestion;

  /// No description provided for @deleteOverseerMessage.
  ///
  /// In en, this message translates to:
  /// **'Remove {title} and its saved login from this device?'**
  String deleteOverseerMessage(String title);

  /// No description provided for @deleteOverseer.
  ///
  /// In en, this message translates to:
  /// **'Delete Overseer'**
  String get deleteOverseer;

  /// No description provided for @overseerDeleteFailed.
  ///
  /// In en, this message translates to:
  /// **'The Overseer could not be deleted. Please try again.'**
  String get overseerDeleteFailed;

  /// No description provided for @openOverseerHint.
  ///
  /// In en, this message translates to:
  /// **'Open this Overseer. Long press for actions.'**
  String get openOverseerHint;

  /// No description provided for @overseerActions.
  ///
  /// In en, this message translates to:
  /// **'Overseer actions'**
  String get overseerActions;

  /// No description provided for @noConnections.
  ///
  /// In en, this message translates to:
  /// **'No connections yet'**
  String get noConnections;

  /// No description provided for @savedServersAppearHere.
  ///
  /// In en, this message translates to:
  /// **'Your saved Overseer servers will appear here.'**
  String get savedServersAppearHere;

  /// No description provided for @addOverseerTitle.
  ///
  /// In en, this message translates to:
  /// **'Add Overseer'**
  String get addOverseerTitle;

  /// No description provided for @overseerUrl.
  ///
  /// In en, this message translates to:
  /// **'Overseer URL'**
  String get overseerUrl;

  /// No description provided for @overseerUrlHint.
  ///
  /// In en, this message translates to:
  /// **'https://overseer.example'**
  String get overseerUrlHint;

  /// No description provided for @overseerUrlHelper.
  ///
  /// In en, this message translates to:
  /// **'This address is saved after you successfully sign in.'**
  String get overseerUrlHelper;

  /// No description provided for @invalidOverseerUrl.
  ///
  /// In en, this message translates to:
  /// **'Enter a valid http:// or https:// URL.'**
  String get invalidOverseerUrl;

  /// No description provided for @duplicateOverseerConnection.
  ///
  /// In en, this message translates to:
  /// **'This Overseer connection is already saved.'**
  String get duplicateOverseerConnection;

  /// No description provided for @overseerUrlOpenFailed.
  ///
  /// In en, this message translates to:
  /// **'The Overseer URL could not be opened. Please try again.'**
  String get overseerUrlOpenFailed;

  /// No description provided for @checkingSignIn.
  ///
  /// In en, this message translates to:
  /// **'Checking sign-in…'**
  String get checkingSignIn;

  /// No description provided for @continueLabel.
  ///
  /// In en, this message translates to:
  /// **'Continue'**
  String get continueLabel;

  /// No description provided for @backToOverseers.
  ///
  /// In en, this message translates to:
  /// **'Back to Overseers'**
  String get backToOverseers;

  /// No description provided for @signInTitle.
  ///
  /// In en, this message translates to:
  /// **'Sign in to Overseer'**
  String get signInTitle;

  /// No description provided for @signInSubtitle.
  ///
  /// In en, this message translates to:
  /// **'Continue with GitHub to access your workspaces.'**
  String get signInSubtitle;

  /// No description provided for @connecting.
  ///
  /// In en, this message translates to:
  /// **'Connecting…'**
  String get connecting;

  /// No description provided for @signIn.
  ///
  /// In en, this message translates to:
  /// **'Sign In'**
  String get signIn;

  /// No description provided for @message.
  ///
  /// In en, this message translates to:
  /// **'Message'**
  String get message;

  /// No description provided for @sendMessageHint.
  ///
  /// In en, this message translates to:
  /// **'Send a message…'**
  String get sendMessageHint;

  /// No description provided for @attachFiles.
  ///
  /// In en, this message translates to:
  /// **'Attach files'**
  String get attachFiles;

  /// No description provided for @steer.
  ///
  /// In en, this message translates to:
  /// **'Steer'**
  String get steer;

  /// No description provided for @queue.
  ///
  /// In en, this message translates to:
  /// **'Queue'**
  String get queue;

  /// No description provided for @send.
  ///
  /// In en, this message translates to:
  /// **'Send'**
  String get send;

  /// No description provided for @queuedMessages.
  ///
  /// In en, this message translates to:
  /// **'{count, plural, =1{1 message waiting to send} other{{count} messages waiting to send}}'**
  String queuedMessages(int count);
}

class _AppLocalizationsDelegate
    extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['en', 'ru'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'en':
      return AppLocalizationsEn();
    case 'ru':
      return AppLocalizationsRu();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.',
  );
}
