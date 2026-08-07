// ignore: unused_import
import 'package:intl/intl.dart' as intl;
import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'Overseer Mobile';

  @override
  String get loadingOverseerConnections => 'Loading Overseer connections';

  @override
  String get overseerConnections => 'Overseer connections';

  @override
  String get addOverseerToStart => 'Add an Overseer server to get started.';

  @override
  String get chooseOverseer => 'Choose an Overseer to continue.';

  @override
  String get addOverseer => 'Add Overseer';

  @override
  String get delete => 'Delete';

  @override
  String get deleteOverseerQuestion => 'Delete Overseer?';

  @override
  String deleteOverseerMessage(String title) {
    return 'Remove $title and its saved login from this device?';
  }

  @override
  String get deleteOverseer => 'Delete Overseer';

  @override
  String get overseerDeleteFailed =>
      'The Overseer could not be deleted. Please try again.';

  @override
  String get openOverseerHint => 'Open this Overseer. Long press for actions.';

  @override
  String get overseerActions => 'Overseer actions';

  @override
  String get noConnections => 'No connections yet';

  @override
  String get savedServersAppearHere =>
      'Your saved Overseer servers will appear here.';

  @override
  String get addOverseerTitle => 'Add Overseer';

  @override
  String get overseerUrl => 'Overseer URL';

  @override
  String get overseerUrlHint => 'https://overseer.example';

  @override
  String get overseerUrlHelper =>
      'This address is saved after you successfully sign in.';

  @override
  String get invalidOverseerUrl => 'Enter a valid http:// or https:// URL.';

  @override
  String get duplicateOverseerConnection =>
      'This Overseer connection is already saved.';

  @override
  String get overseerUrlOpenFailed =>
      'The Overseer URL could not be opened. Please try again.';

  @override
  String get checkingSignIn => 'Checking sign-in…';

  @override
  String get continueLabel => 'Continue';

  @override
  String get backToOverseers => 'Back to Overseers';

  @override
  String get signInTitle => 'Sign in to Overseer';

  @override
  String get signInSubtitle =>
      'Continue with GitHub to access your workspaces.';

  @override
  String get connecting => 'Connecting…';

  @override
  String get signIn => 'Sign In';

  @override
  String get message => 'Message';

  @override
  String get sendMessageHint => 'Send a message…';

  @override
  String get attachFiles => 'Attach files';

  @override
  String get steer => 'Steer';

  @override
  String get queue => 'Queue';

  @override
  String get send => 'Send';

  @override
  String queuedMessages(int count) {
    String _temp0 = intl.Intl.pluralLogic(
      count,
      locale: localeName,
      other: '$count messages waiting to send',
      one: '1 message waiting to send',
    );
    return '$_temp0';
  }

  @override
  String get toolActivityRead => 'Opened a file';

  @override
  String get toolActivitySearch => 'Searched the materials';

  @override
  String get toolActivityWeb => 'Checked external sources';

  @override
  String get toolActivityEdit => 'Updated a file';

  @override
  String get toolActivityAnalysis => 'Performed additional analysis';

  @override
  String get toolActivityCommand => 'Performed a technical operation';

  @override
  String get toolActivityGeneric => 'Performed an action';

  @override
  String get toolActivityFailedShort => 'failed';

  @override
  String get showTechnicalDetails => 'Show technical details';
}
