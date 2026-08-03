import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/inquiries/application/plugin_inquiry_controller.dart';
import 'package:overseer_mobile/features/inquiries/domain/plugin_inquiry.dart';
import 'package:overseer_mobile/features/inquiries/domain/plugin_inquiry_repository.dart';

void main() {
  const scope = PluginInquiryScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
  );

  test(
    'blocks duplicate actions while the first response is pending',
    () async {
      final repository = _Repository();
      final container = ProviderContainer(
        overrides: [
          pluginInquiryRepositoryProvider.overrideWithValue(repository),
        ],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        pluginInquiryControllerProvider(scope),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);
      await _settle();
      final controller = container.read(
        pluginInquiryControllerProvider(scope).notifier,
      );
      final first = controller.respond(
        repository.inquiry,
        PluginInquiryDecision.install,
      );
      final duplicate = controller.respond(
        repository.inquiry,
        PluginInquiryDecision.install,
      );

      expect(repository.respondCalls, 1);
      repository.response.complete(
        repository.inquiry.copyWith(status: PluginInquiryStatus.installed),
      );
      await Future.wait([first, duplicate]);
      expect(repository.respondCalls, 1);
    },
  );

  test(
    'restores pending action and reuses identity after transient failure',
    () async {
      final repository = _Repository(transientFirst: true);
      final container = ProviderContainer(
        overrides: [
          pluginInquiryRepositoryProvider.overrideWithValue(repository),
        ],
      );
      addTearDown(container.dispose);
      final subscription = container.listen(
        pluginInquiryControllerProvider(scope),
        (_, _) {},
        fireImmediately: true,
      );
      addTearDown(subscription.close);
      await _settle();
      final controller = container.read(
        pluginInquiryControllerProvider(scope).notifier,
      );

      await controller.respond(
        repository.inquiry,
        PluginInquiryDecision.install,
      );
      final failed = container.read(pluginInquiryControllerProvider(scope));
      expect(failed.inquiries.single.status, PluginInquiryStatus.pending);
      expect(failed.actionFailed, contains('inq'));
      await controller.respond(
        repository.inquiry,
        PluginInquiryDecision.install,
      );

      expect(repository.requestIds, hasLength(2));
      expect(repository.requestIds.first, repository.requestIds.last);
    },
  );

  test('keeps the last safe envelope visible while offline', () async {
    final repository = _Repository();
    final container = ProviderContainer(
      overrides: [
        pluginInquiryRepositoryProvider.overrideWithValue(repository),
      ],
    );
    addTearDown(container.dispose);
    final subscription = container.listen(
      pluginInquiryControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    await _settle();
    await _settle();

    const offlineScope = PluginInquiryScope(
      workspaceId: 'workspace',
      peonId: 'peon',
      sessionId: 'session',
      online: false,
    );
    final offline = container.read(
      pluginInquiryControllerProvider(offlineScope),
    );
    expect(offline.inquiries.single.plugin.displayName, 'PostHog');
    expect(offline.refreshFailed, isTrue);
  });
}

Future<void> _settle() => Future<void>.delayed(Duration.zero);

class _Repository implements PluginInquiryRepository {
  _Repository({this.transientFirst = false});
  final bool transientFirst;
  final response = Completer<PluginInstallInquiry>();
  var respondCalls = 0;
  final requestIds = <String>[];
  late final inquiry = PluginInstallInquiry(
    inquiryId: 'inq',
    status: PluginInquiryStatus.pending,
    plugin: const PluginIdentity(
      id: 'posthog',
      name: 'posthog',
      displayName: 'PostHog',
      authPolicy: 'ON_INSTALL',
      installPolicy: 'AVAILABLE',
      installed: false,
    ),
    expiresAt: DateTime.utc(2099),
  );

  @override
  Future<List<PluginInstallInquiry>> list(PluginInquiryScope scope) async => [
    inquiry,
  ];

  @override
  Future<PluginInstallInquiry> respond(
    PluginInquiryScope scope, {
    required String inquiryId,
    required PluginInquiryDecision decision,
    required String requestId,
  }) async {
    respondCalls += 1;
    requestIds.add(requestId);
    if (transientFirst && respondCalls == 1) {
      throw const PluginInquiryException('offline', transient: true);
    }
    if (transientFirst) {
      return inquiry.copyWith(status: PluginInquiryStatus.installed);
    }
    return response.future;
  }
}
