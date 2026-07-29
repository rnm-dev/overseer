import 'dart:async';
import 'dart:convert';

import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../config/overseer_connection_store.dart';

enum NotificationDestinationKind { peon, session }

@immutable
class NotificationDestination {
  const NotificationDestination.peon({
    required this.workspaceId,
    required this.peonId,
  }) : kind = NotificationDestinationKind.peon,
       sessionId = null;

  const NotificationDestination.session({
    required this.workspaceId,
    required this.peonId,
    required String this.sessionId,
  }) : kind = NotificationDestinationKind.session;

  static NotificationDestination? fromData(Map<String, dynamic> data) {
    final workspaceId = _safeIdentifier(data['workspaceId']);
    final peonId = _safeIdentifier(data['peonId']);
    if (workspaceId == null || peonId == null) return null;
    final kind = data['kind'];
    final sessionId = _safeIdentifier(data['sessionId']);
    if (kind == 'session' || kind == 'attention') {
      return sessionId == null
          ? null
          : NotificationDestination.session(
              workspaceId: workspaceId,
              peonId: peonId,
              sessionId: sessionId,
            );
    }
    if (kind == 'peon') {
      return NotificationDestination.peon(
        workspaceId: workspaceId,
        peonId: peonId,
      );
    }
    return null;
  }

  static NotificationDestination? fromUri(Uri uri) {
    if (uri.hasScheme &&
        uri.scheme != 'overseer' &&
        uri.scheme != 'overseer-dev') {
      return null;
    }
    if (uri.hasScheme && uri.host != 'open') return null;
    final workspaceId = _safeIdentifier(uri.queryParameters['workspaceId']);
    final peonId = _safeIdentifier(uri.queryParameters['peonId']);
    if (workspaceId == null || peonId == null) return null;
    return switch (uri.path) {
      '/session'
          when _safeIdentifier(uri.queryParameters['sessionId']) != null =>
        NotificationDestination.session(
          workspaceId: workspaceId,
          peonId: peonId,
          sessionId: _safeIdentifier(uri.queryParameters['sessionId'])!,
        ),
      '/peon' => NotificationDestination.peon(
        workspaceId: workspaceId,
        peonId: peonId,
      ),
      _ => null,
    };
  }

  final NotificationDestinationKind kind;
  final String workspaceId;
  final String peonId;
  final String? sessionId;

  String get location {
    final session = sessionId;
    final query = <String, String>{
      'workspaceId': workspaceId,
      'peonId': peonId,
      ...?session == null ? null : <String, String>{'sessionId': session},
    };
    return Uri(path: '/${kind.name}', queryParameters: query).toString();
  }

  static String? _safeIdentifier(Object? value) {
    if (value is! String) return null;
    final trimmed = value.trim();
    if (trimmed.isEmpty || trimmed.length > 512 || trimmed.contains('\u0000')) {
      return null;
    }
    return trimmed;
  }

  @override
  bool operator ==(Object other) =>
      other is NotificationDestination &&
      other.kind == kind &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(kind, workspaceId, peonId, sessionId);
}

@immutable
class InAppNotification {
  const InAppNotification({
    required this.title,
    required this.body,
    required this.destination,
  });

  final String title;
  final String body;
  final NotificationDestination destination;
}

abstract interface class NotificationMessageGateway {
  Stream<InAppNotification> get foregroundNotifications;

  Stream<NotificationDestination> get openedDestinations;

  Future<NotificationDestination?> initialDestination();
}

class NoopNotificationMessageGateway implements NotificationMessageGateway {
  const NoopNotificationMessageGateway();

  @override
  Stream<InAppNotification> get foregroundNotifications => const Stream.empty();

  @override
  Stream<NotificationDestination> get openedDestinations =>
      const Stream.empty();

  @override
  Future<NotificationDestination?> initialDestination() async => null;
}

class FirebaseNotificationMessageGateway implements NotificationMessageGateway {
  FirebaseNotificationMessageGateway({FirebaseMessaging? messaging})
    : _messaging = messaging ?? FirebaseMessaging.instance;

  final FirebaseMessaging _messaging;

  @override
  Stream<InAppNotification> get foregroundNotifications => FirebaseMessaging
      .onMessage
      .map(_foreground)
      .where((notification) => notification != null)
      .cast<InAppNotification>();

  @override
  Stream<NotificationDestination> get openedDestinations => FirebaseMessaging
      .onMessageOpenedApp
      .map((message) => NotificationDestination.fromData(message.data))
      .where((destination) => destination != null)
      .cast<NotificationDestination>();

  @override
  Future<NotificationDestination?> initialDestination() async {
    final message = await _messaging.getInitialMessage();
    return message == null
        ? null
        : NotificationDestination.fromData(message.data);
  }

  InAppNotification? _foreground(RemoteMessage message) {
    final destination = NotificationDestination.fromData(message.data);
    if (destination == null) return null;
    final notification = message.notification;
    final title = _displayText(
      notification?.title,
      fallback: 'Overseer update',
    );
    final body = _displayText(
      notification?.body,
      fallback: destination.kind == NotificationDestinationKind.session
          ? 'Session updated'
          : 'Peon updated',
    );
    return InAppNotification(
      title: title,
      body: body,
      destination: destination,
    );
  }

  String _displayText(String? value, {required String fallback}) {
    final trimmed = value?.trim() ?? '';
    if (trimmed.isEmpty) return fallback;
    return trimmed.length <= 500 ? trimmed : trimmed.substring(0, 500);
  }
}

abstract interface class NotificationRouteStore {
  Future<void> recordConnection({
    required OverseerConnection connection,
    required Iterable<String> workspaceIds,
  });

  Future<Uri?> connectionForWorkspace(String workspaceId);
}

class SharedPreferencesNotificationRouteStore
    implements NotificationRouteStore {
  static const preferenceKey = 'overseer.notification.workspace_connections';

  @override
  Future<Uri?> connectionForWorkspace(String workspaceId) async {
    final preferences = await SharedPreferences.getInstance();
    final routes = _read(preferences);
    return parseOverseerServerUrl(routes[workspaceId] ?? '');
  }

  @override
  Future<void> recordConnection({
    required OverseerConnection connection,
    required Iterable<String> workspaceIds,
  }) async {
    final preferences = await SharedPreferences.getInstance();
    final routes = _read(preferences);
    for (final workspaceId in workspaceIds) {
      if (workspaceId.isNotEmpty) routes[workspaceId] = connection.id;
    }
    await preferences.setString(preferenceKey, jsonEncode(routes));
  }

  Map<String, String> _read(SharedPreferences preferences) {
    try {
      final value = jsonDecode(preferences.getString(preferenceKey) ?? '{}');
      if (value is! Map) return <String, String>{};
      return value.map(
        (key, value) => MapEntry(key.toString(), value.toString()),
      );
    } catch (_) {
      return <String, String>{};
    }
  }
}

abstract interface class WorkspaceConnectionRecorder {
  Future<void> recordWorkspaceIds(Iterable<String> workspaceIds);
}

class NoopWorkspaceConnectionRecorder implements WorkspaceConnectionRecorder {
  const NoopWorkspaceConnectionRecorder();

  @override
  Future<void> recordWorkspaceIds(Iterable<String> workspaceIds) async {}
}

class DefaultWorkspaceConnectionRecorder
    implements WorkspaceConnectionRecorder {
  const DefaultWorkspaceConnectionRecorder({
    required this.store,
    required this.connection,
  });

  final NotificationRouteStore store;
  final OverseerConnection connection;

  @override
  Future<void> recordWorkspaceIds(Iterable<String> workspaceIds) {
    return store.recordConnection(
      connection: connection,
      workspaceIds: workspaceIds,
    );
  }
}
