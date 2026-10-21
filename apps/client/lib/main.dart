import 'package:desktop_webview_window/desktop_webview_window.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, TargetPlatform;
import 'package:flutter/material.dart';
import 'package:overseer_mobile/app/app_bootstrap.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/core/notifications/windows_notifications.dart';
import 'package:overseer_mobile/firebase_options.dart';

Future<void> main(List<String> args) async {
  WidgetsFlutterBinding.ensureInitialized();
  // The desktop WebView title-bar helper process must not start the app.
  if (runWebViewTitleBarWidget(args)) return;

  if (defaultTargetPlatform != TargetPlatform.linux && Firebase.apps.isEmpty) {
    try {
      await Firebase.initializeApp(
        options: DefaultFirebaseOptions.currentPlatform,
      );
    } on FirebaseException catch (error) {
      if (error.code != 'duplicate-app') rethrow;
    }
  }

  final supportsNativePush =
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;
  final desktopNotifications = defaultTargetPlatform == TargetPlatform.windows
      ? WindowsNotifications()
      : null;
  runApp(
    AppBootstrap(
      desktopNotifications: desktopNotifications,
      notificationGateway: supportsNativePush
          ? FirebaseNotificationMessageGateway()
          : desktopNotifications ?? const NoopNotificationMessageGateway(),
    ),
  );
}
