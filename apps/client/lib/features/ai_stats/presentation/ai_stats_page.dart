import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/status_badge.dart';
import '../application/ai_stats_controller.dart';
import '../domain/ai_stats_models.dart';
import '../domain/ai_stats_repository.dart';

class AiStatsPage extends ConsumerStatefulWidget {
  const AiStatsPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.online,
  });

  final String workspaceId;
  final String peonId;
  final bool online;

  @override
  ConsumerState<AiStatsPage> createState() => _AiStatsPageState();
}

class _AiStatsPageState extends ConsumerState<AiStatsPage> {
  AiStatsPeriod _period = AiStatsPeriod.day;

  AiStatsScope get _scope => AiStatsScope(
    workspaceId: widget.workspaceId,
    peonId: widget.peonId,
    period: _period,
    online: widget.online,
  );

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(aiStatsControllerProvider(_scope));
    return RefreshIndicator(
      onRefresh: () =>
          ref.read(aiStatsControllerProvider(_scope).notifier).refresh(),
      child: CustomScrollView(
        key: const Key('ai-stats-scroll'),
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 14, 12, 8),
              child: _PeriodPicker(
                period: _period,
                onChanged: (period) => setState(() => _period = period),
              ),
            ),
          ),
          state.when(
            skipLoadingOnRefresh: true,
            data: (stats) => SliverPadding(
              padding: const EdgeInsets.fromLTRB(12, 6, 12, 32),
              sliver: SliverList.list(
                children: [
                  _HeadlineStats(stats: stats),
                  if (!widget.online) ...[
                    const SizedBox(height: 10),
                    const _OfflineBanner(),
                  ],
                  const SizedBox(height: 12),
                  _TokenBreakdown(stats: stats),
                  const SizedBox(height: 18),
                  if (widget.online)
                    for (final provider in AiProvider.values) ...[
                      _ProviderCard(
                        workspaceId: widget.workspaceId,
                        peonId: widget.peonId,
                        provider: provider,
                        models: stats.byModel
                            .where((model) => model.agent == provider.apiValue)
                            .toList(growable: false),
                      ),
                      const SizedBox(height: 14),
                    ],
                ],
              ),
            ),
            loading: () => const SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: SizedBox.square(
                  dimension: 22,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              ),
            ),
            error: (error, _) => SliverFillRemaining(
              hasScrollBody: false,
              child: _StatsNotice(
                message: error is AiStatsException && error.unsupported
                    ? 'Update this peon to view AI statistics.'
                    : error.toString(),
                onRetry: () => ref
                    .read(aiStatsControllerProvider(_scope).notifier)
                    .refresh(),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _PeriodPicker extends StatelessWidget {
  const _PeriodPicker({required this.period, required this.onChanged});

  final AiStatsPeriod period;
  final ValueChanged<AiStatsPeriod> onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        for (final (index, value) in AiStatsPeriod.values.indexed) ...[
          if (index > 0) const SizedBox(width: 6),
          Expanded(
            child: Semantics(
              selected: value == period,
              button: true,
              child: InkWell(
                key: Key('stats-period-${value.name}'),
                onTap: () => onChanged(value),
                borderRadius: BorderRadius.circular(5),
                child: Container(
                  constraints: const BoxConstraints(minHeight: 48),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    border: Border.all(
                      color: value == period
                          ? AppColors.fel
                          : AppColors.iron800,
                    ),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: FittedBox(
                    fit: BoxFit.scaleDown,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 5),
                      child: Text(
                        value.label.toUpperCase(),
                        maxLines: 1,
                        style: AppTypography.display(
                          fontSize: 10,
                          fontWeight: FontWeight.w700,
                          color: value == period
                              ? AppColors.felBright
                              : AppColors.boneDim,
                          letterSpacing: 1,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

class _HeadlineStats extends StatelessWidget {
  const _HeadlineStats({required this.stats});

  final AiStats stats;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = (constraints.maxWidth - 10) / 2;
        return Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            _StatPlate(
              width: width,
              value: _count(stats.sessionCount),
              label: 'Sessions',
            ),
            _StatPlate(
              width: width,
              value: _count(stats.totalOutputTokens),
              label: 'Output',
              tone: AppColors.forge,
            ),
            _StatPlate(
              width: width,
              value: _duration(stats.totalDurationMs),
              label: 'Duration',
            ),
          ],
        );
      },
    );
  }
}

class _StatPlate extends StatelessWidget {
  const _StatPlate({
    required this.width,
    required this.value,
    required this.label,
    this.tone = AppColors.bone,
  });

  final double width;
  final String value;
  final String label;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      key: Key('stats-${label.toLowerCase()}'),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      decoration: BoxDecoration(
        color: AppColors.iron950,
        border: Border.all(color: AppColors.iron800),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            maxLines: 1,
            style: AppTypography.mono(
              fontSize: 20,
              fontWeight: FontWeight.w600,
              color: tone,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            label.toUpperCase(),
            style: AppTypography.display(
              fontSize: 9,
              color: AppColors.boneDim,
              letterSpacing: 1.3,
            ),
          ),
        ],
      ),
    );
  }
}

class _TokenBreakdown extends StatelessWidget {
  const _TokenBreakdown({required this.stats});

  final AiStats stats;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (stats.sessionsMissingUsage > 0)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              '${stats.sessionsMissingUsage} run(s) missing usage data.',
              style: AppTypography.mono(
                fontSize: 11,
                color: AppColors.boneFaint,
              ),
            ),
          ),
        Wrap(
          spacing: 14,
          runSpacing: 5,
          children: [
            _BreakdownValue(label: 'Input', value: stats.totalInputTokens),
            _BreakdownValue(
              label: 'Cache write',
              value: stats.totalCacheCreationTokens,
            ),
            _BreakdownValue(
              label: 'Cache read',
              value: stats.totalCacheReadTokens,
            ),
          ],
        ),
      ],
    );
  }
}

class _BreakdownValue extends StatelessWidget {
  const _BreakdownValue({required this.label, required this.value});

  final String label;
  final int value;

  @override
  Widget build(BuildContext context) {
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(
            text: '$label ',
            style: AppTypography.mono(fontSize: 11, color: AppColors.boneFaint),
          ),
          TextSpan(
            text: _count(value),
            style: AppTypography.mono(fontSize: 11, color: AppColors.boneDim),
          ),
        ],
      ),
    );
  }
}

class _StatsNotice extends StatelessWidget {
  const _StatsNotice({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.mono(
                fontSize: 13,
                color: AppColors.boneFaint,
              ),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              TextButton(onPressed: onRetry, child: const Text('Retry')),
            ],
          ],
        ),
      ),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.forgeDeep.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        'Offline · showing the last saved statistics.',
        style: AppTypography.mono(fontSize: 11, color: AppColors.ember),
      ),
    );
  }
}

class _ProviderCard extends ConsumerWidget {
  const _ProviderCard({
    required this.workspaceId,
    required this.peonId,
    required this.provider,
    required this.models,
  });

  final String workspaceId;
  final String peonId;
  final AiProvider provider;
  final List<AiModelUsage> models;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final scope = AiProviderScope(
      workspaceId: workspaceId,
      peonId: peonId,
      provider: provider,
    );
    final quota = ref.watch(aiQuotaControllerProvider(scope));
    final capabilities = ref.watch(aiCapabilitiesControllerProvider(scope));
    final recordedTokens = models.fold<int>(
      0,
      (total, model) => total + model.totalTokens,
    );
    final recordedDuration = models.fold<int>(
      0,
      (total, model) => total + model.totalDurationMs,
    );

    return Material(
      key: Key('stats-provider-${provider.apiValue}'),
      color: AppColors.iron950,
      shape: RoundedRectangleBorder(
        side: const BorderSide(color: AppColors.iron800),
        borderRadius: BorderRadius.circular(7),
      ),
      child: Padding(
        padding: const EdgeInsets.all(15),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              provider.label.toUpperCase(),
                              style: AppTypography.display(
                                fontSize: 13,
                                fontWeight: FontWeight.w700,
                                letterSpacing: 1.2,
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          quota.when(
                            data: (data) => StatusBadge(
                              label: data.status,
                              tone: _statusTone(data.status),
                            ),
                            loading: () => const StatusBadge(label: 'Checking'),
                            error: (_, _) => const StatusBadge(
                              label: 'Error',
                              tone: StatusBadgeTone.danger,
                            ),
                          ),
                        ],
                      ),
                      if (quota.value?.accountEmail case final email?
                          when email.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 5),
                          child: Text(
                            'Signed in as $email',
                            style: AppTypography.mono(
                              fontSize: 10.5,
                              color: AppColors.boneDim,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
                TextButton(
                  onPressed: quota.isLoading || capabilities.isLoading
                      ? null
                      : () {
                          ref
                              .read(aiQuotaControllerProvider(scope).notifier)
                              .refresh();
                          ref
                              .read(
                                aiCapabilitiesControllerProvider(
                                  scope,
                                ).notifier,
                              )
                              .refresh();
                        },
                  child: Text(
                    quota.isLoading || capabilities.isLoading
                        ? 'Refreshing…'
                        : 'Refresh',
                  ),
                ),
              ],
            ),
            if (quota.hasError)
              _InlineError(message: quota.error.toString())
            else if (quota.value?.error case final message?)
              _InlineError(message: message),
            const SizedBox(height: 18),
            const _CardSectionTitle('RECORDED'),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: _MiniStat(
                    value: _count(recordedTokens),
                    label: 'Tokens',
                    tone: AppColors.forge,
                  ),
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: _MiniStat(
                    value: _duration(recordedDuration),
                    label: 'Duration',
                  ),
                ),
              ],
            ),
            if (models.isEmpty)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  'No recorded usage for this period.',
                  style: AppTypography.mono(
                    fontSize: 11,
                    color: AppColors.boneFaint,
                  ),
                ),
              )
            else
              Padding(
                padding: const EdgeInsets.only(top: 10),
                child: Column(
                  children: [
                    for (final model in models)
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: Row(
                          children: [
                            Expanded(
                              child: Text(
                                model.model.isEmpty ? '—' : model.model,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: AppTypography.mono(fontSize: 11),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Text(
                              '${_count(model.totalTokens)} · '
                              '${_duration(model.totalDurationMs)}',
                              style: AppTypography.mono(
                                fontSize: 10.5,
                                color: AppColors.boneFaint,
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: 20),
            const _CardSectionTitle('ACCOUNT LIMITS'),
            const SizedBox(height: 9),
            quota.when(
              data: (data) => data.windows.isEmpty
                  ? Text(
                      'No account limits reported.',
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppColors.boneFaint,
                      ),
                    )
                  : Column(
                      children: [
                        for (final window in data.windows)
                          _QuotaWindowRow(window: window),
                      ],
                    ),
              loading: () => const Align(
                alignment: Alignment.centerLeft,
                child: SizedBox.square(
                  dimension: 17,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                ),
              ),
              error: (_, _) => Text(
                'No account limits reported.',
                style: AppTypography.mono(
                  fontSize: 11,
                  color: AppColors.boneFaint,
                ),
              ),
            ),
            const SizedBox(height: 18),
            const Divider(height: 1, color: AppColors.iron800),
            const SizedBox(height: 13),
            const _CardSectionTitle('CAPABILITIES'),
            const SizedBox(height: 3),
            _CapabilitiesInventory(state: capabilities),
          ],
        ),
      ),
    );
  }
}

class _CardSectionTitle extends StatelessWidget {
  const _CardSectionTitle(this.label);

  final String label;

  @override
  Widget build(BuildContext context) {
    return Text(
      label,
      style: AppTypography.display(
        fontSize: 9,
        color: AppColors.boneDim,
        letterSpacing: 1.4,
      ),
    );
  }
}

class _MiniStat extends StatelessWidget {
  const _MiniStat({
    required this.value,
    required this.label,
    this.tone = AppColors.bone,
  });

  final String value;
  final String label;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 10),
      decoration: BoxDecoration(
        color: AppColors.iron900,
        border: Border.all(color: AppColors.iron800),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.fade,
            style: AppTypography.mono(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: tone,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            label.toUpperCase(),
            maxLines: 1,
            style: AppTypography.display(
              fontSize: 8,
              color: AppColors.boneDim,
              letterSpacing: 1,
            ),
          ),
        ],
      ),
    );
  }
}

class _QuotaWindowRow extends StatelessWidget {
  const _QuotaWindowRow({required this.window});

  final AiQuotaWindow window;

  @override
  Widget build(BuildContext context) {
    final percent = window.usedPercent.clamp(0, 100).toDouble();
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  [
                    window.label,
                    if (window.modelIds.isNotEmpty) window.modelIds.join(', '),
                  ].join(' · '),
                  style: AppTypography.mono(fontSize: 11),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '${window.usedPercent.toStringAsFixed(0)}%',
                style: AppTypography.mono(
                  fontSize: 11,
                  color: AppColors.boneDim,
                ),
              ),
            ],
          ),
          const SizedBox(height: 6),
          ClipRRect(
            borderRadius: BorderRadius.circular(2),
            child: LinearProgressIndicator(
              minHeight: 7,
              value: percent / 100,
              color: AppColors.fel,
              backgroundColor: AppColors.iron900,
            ),
          ),
          const SizedBox(height: 5),
          Text(
            'Resets in ${_reset(window.resetsAt)}',
            style: AppTypography.mono(fontSize: 10, color: AppColors.boneFaint),
          ),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.only(left: 9),
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: AppColors.blood, width: 2)),
      ),
      child: Text(
        message,
        style: AppTypography.mono(fontSize: 10.5, color: AppColors.blood),
      ),
    );
  }
}

class _CapabilitiesInventory extends StatelessWidget {
  const _CapabilitiesInventory({required this.state});

  final AsyncValue<AiProviderCapabilities> state;

  @override
  Widget build(BuildContext context) {
    return state.when(
      data: (data) => Column(
        children: [
          if (data.error case final message?) _InlineError(message: message),
          _CapabilityGroup(label: 'Plugins', items: data.plugins),
          _CapabilityGroup(label: 'Skills', items: data.skills),
          _CapabilityGroup(label: 'MCP', items: data.mcps),
        ],
      ),
      loading: () => const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: Align(
          alignment: Alignment.centerLeft,
          child: SizedBox.square(
            dimension: 17,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          ),
        ),
      ),
      error: (error, _) => _InlineError(message: error.toString()),
    );
  }
}

class _CapabilityGroup extends StatelessWidget {
  const _CapabilityGroup({required this.label, required this.items});

  final String label;
  final List<AiCapabilityItem> items;

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: Theme.of(context).copyWith(dividerColor: AppColors.iron800),
      child: ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(bottom: 8),
        minTileHeight: 46,
        iconColor: AppColors.boneDim,
        collapsedIconColor: AppColors.boneDim,
        title: Text(label, style: AppTypography.display(fontSize: 11)),
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: AppColors.iron900,
                borderRadius: BorderRadius.circular(4),
              ),
              child: Text(
                '${items.length}',
                style: AppTypography.mono(
                  fontSize: 10,
                  color: AppColors.boneDim,
                ),
              ),
            ),
            const SizedBox(width: 4),
            const Icon(Icons.expand_more, size: 18),
          ],
        ),
        children: [
          if (items.isEmpty)
            Align(
              alignment: Alignment.centerLeft,
              child: Text(
                'None reported.',
                style: AppTypography.mono(
                  fontSize: 11,
                  color: AppColors.boneFaint,
                ),
              ),
            )
          else
            for (final item in items) _CapabilityRow(item: item),
        ],
      ),
    );
  }
}

class _CapabilityRow extends StatelessWidget {
  const _CapabilityRow({required this.item});

  final AiCapabilityItem item;

  @override
  Widget build(BuildContext context) {
    final metadata = [
      if (item.version case final value? when value.isNotEmpty)
        'Version: $value',
      if (item.source case final value? when value.isNotEmpty) 'Source: $value',
      if (item.transport case final value? when value.isNotEmpty)
        'Transport: $value',
    ];
    return Container(
      padding: const EdgeInsets.symmetric(vertical: 9),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.iron800)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  item.name.isEmpty ? item.id : item.name,
                  style: AppTypography.mono(fontSize: 11),
                ),
              ),
              StatusBadge(
                label: item.enabled ? 'Enabled' : 'Disabled',
                tone: item.enabled
                    ? StatusBadgeTone.success
                    : StatusBadgeTone.neutral,
              ),
            ],
          ),
          if (metadata.isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              metadata.join(' · '),
              style: AppTypography.mono(
                fontSize: 10,
                color: AppColors.boneFaint,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

StatusBadgeTone _statusTone(String status) => switch (status) {
  'ok' => StatusBadgeTone.success,
  'error' => StatusBadgeTone.danger,
  _ => StatusBadgeTone.neutral,
};

String _count(int value) {
  if (value >= 1000000) {
    return '${_trim(value / 1000000)}M';
  }
  if (value >= 1000) {
    return '${_trim(value / 1000)}K';
  }
  return '$value';
}

String _trim(double value) {
  final fixed = value.toStringAsFixed(1);
  return fixed.endsWith('.0') ? fixed.substring(0, fixed.length - 2) : fixed;
}

String _duration(int milliseconds) {
  final seconds = (milliseconds / 1000).round();
  final hours = seconds ~/ 3600;
  final minutes = (seconds % 3600) ~/ 60;
  final remainder = seconds % 60;
  if (hours > 0) return '${hours}h ${minutes}m';
  if (minutes > 0) return '${minutes}m ${remainder}s';
  return '${seconds}s';
}

String _reset(int? resetsAt) {
  if (resetsAt == null) return '—';
  final remaining = Duration(
    milliseconds: resetsAt - DateTime.now().millisecondsSinceEpoch,
  );
  if (remaining.isNegative) return 'now';
  final days = remaining.inDays;
  final hours = remaining.inHours.remainder(24);
  final minutes = remaining.inMinutes.remainder(60);
  if (days > 0) return '${days}d ${hours}h';
  if (hours > 0) return '${hours}h ${minutes}m';
  return '${minutes + 1}m';
}
