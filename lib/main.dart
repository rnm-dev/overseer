import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:overseer_mobile/app/app_bootstrap.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/core/platform/desktop_webview_bootstrap.dart';
import 'package:overseer_mobile/firebase_options.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  if (handleDesktopWebViewProcess(args)) return;

  if ((kIsWeb || defaultTargetPlatform != TargetPlatform.linux) &&
      Firebase.apps.isEmpty) {
    try {
      await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
    } on FirebaseException catch (error) {
      if (error.code != 'duplicate-app') rethrow;
    }
  }

  final supportsNativePush =
      !kIsWeb &&
      (defaultTargetPlatform == TargetPlatform.android ||
          defaultTargetPlatform == TargetPlatform.iOS);
  runApp(
    AppBootstrap(
      notificationGateway: supportsNativePush
          ? FirebaseNotificationMessageGateway()
          : const NoopNotificationMessageGateway(),
    ),
  );
}
