import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/inquiries/data/dio_plugin_inquiry_repository.dart';
import 'package:overseer_mobile/features/inquiries/domain/plugin_inquiry.dart';
import 'package:overseer_mobile/features/inquiries/domain/plugin_inquiry_repository.dart';

void main() {
  const scope = PluginInquiryScope(
    workspaceId: 'workspace / one',
    peonId: 'peon',
    sessionId: 'session',
  );

  test('lists inquiries through the session-scoped route', () async {
    RequestOptions? request;
    final dio = Dio()
      ..interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            request = options;
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: {
                  'version': 'inquiry-v1',
                  'inquiries': [_envelope('pending')],
                },
              ),
            );
          },
        ),
      );

    final rows = await DioPluginInquiryRepository(dio).list(scope);

    expect(
      request?.path,
      'workspaces/workspace%20%2F%20one/peons/peon/sessions/session/inquiries',
    );
    expect(request?.headers['Cache-Control'], 'no-store');
    expect(rows.single.plugin.displayName, 'PostHog');
  });

  test('responds once with public idempotency and decision fields', () async {
    RequestOptions? request;
    final dio = Dio()
      ..interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            request = options;
            handler.resolve(
              Response<Map<String, dynamic>>(
                requestOptions: options,
                data: _envelope('installed'),
              ),
            );
          },
        ),
      );

    final result = await DioPluginInquiryRepository(dio).respond(
      scope,
      inquiryId: 'inq/1',
      decision: PluginInquiryDecision.install,
      requestId: 'stable-request',
    );

    expect(request?.path, endsWith('/inquiries/inq%2F1/response'));
    expect(request?.headers['Peon-Request-Id'], 'stable-request');
    expect(request?.data, {'action': 'install'});
    expect(result.status, PluginInquiryStatus.installed);
  });
}

Map<String, dynamic> _envelope(String status) => {
  'version': 'inquiry-v1',
  'inquiryId': 'inq-1',
  'kind': 'managed_plugin_install',
  'status': status,
  'plugin': {
    'id': 'posthog',
    'name': 'posthog',
    'displayName': 'PostHog',
    'authPolicy': 'ON_INSTALL',
    'installPolicy': 'AVAILABLE',
    'installed': false,
    'capabilities': <String>[],
  },
  'expiresAt': '2026-08-03T12:00:00Z',
  'terminalCode': null,
  'authPolicy': null,
  'appsNeedingAuth': <Object>[],
};
