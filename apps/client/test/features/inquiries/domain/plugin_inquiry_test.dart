import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/inquiries/domain/plugin_inquiry.dart';

void main() {
  test('parses only the public inquiry-v1 plugin envelope', () {
    final inquiry = PluginInstallInquiry.fromJson({
      'version': 'inquiry-v1',
      'inquiryId': 'inq-public',
      'kind': 'managed_plugin_install',
      'status': 'auth_required',
      'plugin': {
        'id': 'posthog',
        'name': 'posthog',
        'displayName': 'PostHog',
        'authPolicy': 'ON_INSTALL',
        'installPolicy': 'AVAILABLE',
        'installed': false,
        'developerName': 'PostHog',
        'capabilities': <String>[],
      },
      'expiresAt': '2026-08-03T12:00:00Z',
      'terminalCode': null,
      'authPolicy': 'ON_INSTALL',
      'appsNeedingAuth': [
        {'id': 'posthog', 'name': 'PostHog'},
      ],
      'nativeRequestId': 'must-not-be-read',
    });

    expect(inquiry.inquiryId, 'inq-public');
    expect(inquiry.status, PluginInquiryStatus.authRequired);
    expect(inquiry.plugin.displayName, 'PostHog');
    expect(inquiry.appsNeedingAuth.single.name, 'PostHog');
  });

  test('fails closed for unknown versions, kinds, and statuses', () {
    Map<String, dynamic> envelope(String status) => {
      'version': 'inquiry-v1',
      'inquiryId': 'inq',
      'kind': 'managed_plugin_install',
      'status': status,
      'plugin': _plugin(),
      'expiresAt': '2026-08-03T12:00:00Z',
    };

    expect(
      () => PluginInstallInquiry.fromJson(envelope('native_pending')),
      throwsFormatException,
    );
    expect(
      () => PluginInstallInquiry.fromJson({
        ...envelope('pending'),
        'kind': 'html',
      }),
      throwsFormatException,
    );
  });

  test(
    'locally expires an actionable request without changing terminal state',
    () {
      final pending = PluginInstallInquiry.fromJson({
        'version': 'inquiry-v1',
        'inquiryId': 'inq',
        'kind': 'managed_plugin_install',
        'status': 'pending',
        'plugin': _plugin(),
        'expiresAt': '2026-08-03T12:00:00Z',
      });

      expect(
        pending.effectiveAt(DateTime.parse('2026-08-03T12:00:01Z')).status,
        PluginInquiryStatus.expired,
      );
      expect(
        pending
            .copyWith(status: PluginInquiryStatus.installed)
            .effectiveAt(DateTime.parse('2026-08-03T12:00:01Z'))
            .status,
        PluginInquiryStatus.installed,
      );
    },
  );
}

Map<String, dynamic> _plugin() => {
  'id': 'plugin',
  'name': 'plugin',
  'displayName': 'Plugin',
  'authPolicy': 'ON_USE',
  'installPolicy': 'AVAILABLE',
  'installed': false,
  'capabilities': <String>[],
};
