import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/diagnostics/app_diagnostics.dart';

void main() {
  test('structured events expose only the bounded safe schema', () {
    const event = AppDiagnosticEvent(
      name: 'live.connection',
      level: AppDiagnosticLevel.warning,
      connectionId: 'connection',
      workspaceId: 'workspace',
      sessionId: 'session',
      state: 'disconnected',
      outcome: 'retrying',
      cursor: 42,
      attempt: 3,
      errorType: 'SocketException',
    );

    expect(event.toJson(), {
      'event': 'live.connection',
      'level': 'warning',
      'connectionId': 'connection',
      'workspaceId': 'workspace',
      'sessionId': 'session',
      'state': 'disconnected',
      'outcome': 'retrying',
      'cursor': 42,
      'attempt': 3,
      'errorType': 'SocketException',
    });
  });
}
