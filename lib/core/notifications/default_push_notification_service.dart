import 'dart:async';

import 'push_notification_service.dart';

class DefaultPushNotificationService implements PushNotificationService {
  DefaultPushNotificationService(this._messaging, this._remote, this._platform);

  final PushMessagingClient _messaging;
  final PushSubscriptionRemote _remote;
  final PushPlatform _platform;

  String? _authToken;
  String? _pushToken;
  String? _subscriptionId;
  StreamSubscription<String>? _tokenRefreshSubscription;
  Future<void> _pending = Future<void>.value();

  @override
  Future<void> setAuthToken(String? authToken) {
    _pending = _pending
        .catchError((_) {})
        .then((_) => _setAuthToken(authToken));
    return _pending;
  }

  Future<void> _setAuthToken(String? authToken) async {
    if (authToken == _authToken && _subscriptionId != null) return;

    final previousAuthToken = _authToken;
    final previousSubscriptionId = _subscriptionId;
    _authToken = authToken;
    _pushToken = null;
    _subscriptionId = null;

    if (previousAuthToken != null && previousSubscriptionId != null) {
      try {
        await _remote.delete(
          authToken: previousAuthToken,
          subscriptionId: previousSubscriptionId,
        );
      } catch (_) {
        // Signing out and switching accounts must not be blocked by cleanup.
      }
    }
    if (authToken == null) return;

    _tokenRefreshSubscription ??= _messaging.onTokenRefresh.listen(
      (token) => unawaited(_register(token)),
    );

    try {
      if (!await _messaging.requestPermission()) return;
      if (_platform == PushPlatform.ios) {
        await _messaging.configureForegroundPresentation();
      }
      final token = await _messaging.getToken();
      if (token != null && token.isNotEmpty) await _register(token);
    } catch (_) {
      // Registration is retried on the next authenticated launch or token
      // refresh. Push setup must never prevent the app from opening.
    }
  }

  Future<void> _register(String token) async {
    final authToken = _authToken;
    if (authToken == null || token.isEmpty || token == _pushToken) return;

    try {
      final previousSubscriptionId = _subscriptionId;
      final subscriptionId = await _remote.register(
        authToken: authToken,
        platform: _platform,
        pushToken: token,
        appId: _messaging.appId,
      );
      if (_authToken != authToken) return;

      _pushToken = token;
      _subscriptionId = subscriptionId;
      if (previousSubscriptionId != null &&
          previousSubscriptionId != subscriptionId) {
        try {
          await _remote.delete(
            authToken: authToken,
            subscriptionId: previousSubscriptionId,
          );
        } catch (_) {
          // The stale OS token will stop receiving messages after rotation.
        }
      }
    } catch (_) {
      // See _setAuthToken: token refresh and the next launch provide retries.
    }
  }

  @override
  Future<void> dispose() async {
    await _tokenRefreshSubscription?.cancel();
  }
}
