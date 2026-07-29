import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/ai_stats/application/ai_stats_controller.dart';
import 'package:overseer_mobile/features/ai_stats/domain/ai_stats_models.dart';
import 'package:overseer_mobile/features/ai_stats/domain/ai_stats_repository.dart';
import 'package:overseer_mobile/features/ai_stats/presentation/ai_stats_page.dart';
import 'package:overseer_mobile/shared/design/theme.dart';

void main() {
  testWidgets('renders web-parity totals and changes period', (tester) async {
    final repository = _FakeAiStatsRepository();
    await tester.pumpWidget(_app(repository));
    await tester.pumpAndSettle();

    expect(find.text('12'), findsOneWidget);
    expect(find.text('18.4K'), findsOneWidget);
    expect(find.text('2h 18m'), findsOneWidget);
    expect(find.text('Input 1.2M'), findsOneWidget);
    expect(find.text('Cache write 80K'), findsOneWidget);
    expect(find.text('Cache read 14.7M'), findsOneWidget);
    expect(find.textContaining(r'$'), findsNothing);
    expect(find.text('OUTCOMES'), findsNothing);

    await tester.tap(find.byKey(const Key('stats-period-week')));
    await tester.pumpAndSettle();
    expect(repository.lastPeriod, AiStatsPeriod.week);
  });

  testWidgets('renders Codex first with quota and capabilities', (
    tester,
  ) async {
    await tester.pumpWidget(_app(_FakeAiStatsRepository()));
    await tester.pumpAndSettle();

    await tester.scrollUntilVisible(
      find.byKey(const Key('stats-provider-codex')),
      400,
      scrollable: find.byType(Scrollable).first,
    );
    final scrollable = tester.state<ScrollableState>(
      find.byType(Scrollable).first,
    );
    final codexOffset = scrollable.position.pixels;
    expect(find.text('CODEX'), findsOneWidget);

    await tester.scrollUntilVisible(
      find.byKey(const Key('stats-provider-claude-code')),
      400,
      scrollable: find.byType(Scrollable).first,
    );
    expect(scrollable.position.pixels, greaterThan(codexOffset));
    expect(find.text('CLAUDE CODE'), findsOneWidget);
    expect(find.text('5-hour limit · claude-sonnet-5'), findsOneWidget);
    expect(find.text('63%'), findsWidgets);
    expect(find.text('claude-sonnet-5'), findsWidgets);

    await tester.scrollUntilVisible(
      find.text('CAPABILITIES').first,
      400,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Plugins'), findsWidgets);
    expect(find.text('Skills'), findsWidgets);
    expect(find.text('MCP'), findsWidgets);
    expect(find.textContaining(r'$'), findsNothing);
    expect(find.text('CREDITS'), findsNothing);
    expect(find.text('OUTCOMES'), findsNothing);
  });

  testWidgets('shows offline state without making requests', (tester) async {
    final repository = _FakeAiStatsRepository();
    await tester.pumpWidget(_app(repository, online: false));
    await tester.pumpAndSettle();

    expect(find.textContaining('offline'), findsOneWidget);
    expect(repository.statsLoads, 0);
  });
}

Widget _app(_FakeAiStatsRepository repository, {bool online = true}) {
  return ProviderScope(
    overrides: [aiStatsRepositoryProvider.overrideWithValue(repository)],
    child: MaterialApp(
      theme: AppTheme.dark,
      home: Scaffold(
        body: AiStatsPage(
          workspaceId: 'workspace',
          peonId: 'peon',
          online: online,
        ),
      ),
    ),
  );
}

class _FakeAiStatsRepository implements AiStatsRepository {
  AiStatsPeriod? lastPeriod;
  int statsLoads = 0;

  @override
  Future<AiStats?> loadCachedStats({
    required String workspaceId,
    required String peonId,
    required AiStatsPeriod period,
  }) async => null;

  @override
  Future<AiStats> refreshStats({
    required String workspaceId,
    required String peonId,
    required AiStatsPeriod period,
  }) async {
    statsLoads += 1;
    lastPeriod = period;
    return AiStats(
      period: period.apiValue,
      rangeStart: 0,
      rangeEnd: 1,
      sessionCount: 12,
      outcomeCounts: const {
        'success': 8,
        'failure': 1,
        'needs_human': 2,
        'running': 1,
        'none': 0,
      },
      totalInputTokens: 1200000,
      totalOutputTokens: 18400,
      totalCacheCreationTokens: 80000,
      totalCacheReadTokens: 14700000,
      totalTokens: 15998400,
      totalDurationMs: 8280000,
      totalCostUsd: 7.42,
      sessionsWithUsage: 11,
      sessionsMissingUsage: 1,
      byModel: const [
        AiModelUsage(
          agent: 'claude-code',
          model: 'claude-sonnet-5',
          sessionCount: 8,
          totalTokens: 12000000,
          inputTokens: 1000000,
          outputTokens: 15000,
          cacheCreationTokens: 70000,
          cacheReadTokens: 10915000,
          totalDurationMs: 7200000,
          totalCostUsd: 6.2,
        ),
        AiModelUsage(
          agent: 'codex',
          model: 'gpt-5.4',
          sessionCount: 4,
          totalTokens: 3998400,
          inputTokens: 200000,
          outputTokens: 3400,
          cacheCreationTokens: 10000,
          cacheReadTokens: 3785000,
          totalDurationMs: 1080000,
          totalCostUsd: 1.22,
        ),
      ],
    );
  }

  @override
  Future<AiProviderQuota> loadQuota({
    required String workspaceId,
    required String peonId,
    required AiProvider provider,
    bool refresh = false,
  }) async {
    return AiProviderQuota(
      provider: provider.apiValue,
      status: 'ok',
      source: 'oauth',
      updatedAt: 1,
      accountEmail: '${provider.apiValue}@example.com',
      windows: [
        AiQuotaWindow(
          id: 'five-hour',
          label: '5-hour limit',
          usedPercent: 63,
          resetsAt: DateTime.now()
              .add(const Duration(hours: 1))
              .millisecondsSinceEpoch,
          modelIds: provider == AiProvider.claudeCode
              ? const ['claude-sonnet-5']
              : const ['gpt-5.4'],
        ),
      ],
      credits: const AiQuotaCredits(
        balance: 12,
        used: 3,
        limit: 15,
        currency: 'USD',
      ),
    );
  }

  @override
  Future<AiProviderCapabilities> loadCapabilities({
    required String workspaceId,
    required String peonId,
    required AiProvider provider,
    bool refresh = false,
  }) async {
    return AiProviderCapabilities(
      provider: provider.apiValue,
      status: 'ok',
      updatedAt: 1,
      plugins: const [
        AiCapabilityItem(
          id: 'github',
          name: 'GitHub',
          enabled: true,
          version: '1.0',
        ),
      ],
      skills: const [
        AiCapabilityItem(
          id: 'mobile',
          name: 'Mobile development',
          enabled: true,
        ),
      ],
      mcps: const [],
    );
  }
}
