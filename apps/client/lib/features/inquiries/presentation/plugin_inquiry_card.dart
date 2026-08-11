import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../domain/plugin_inquiry.dart';

class PluginInquiryCard extends StatelessWidget {
  const PluginInquiryCard({
    super.key,
    required this.inquiry,
    required this.online,
    required this.acting,
    required this.onInstall,
    required this.onCancel,
  });

  final PluginInstallInquiry inquiry;
  final bool online;
  final bool acting;
  final VoidCallback onInstall;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final actionable = inquiry.status.isActionable;
    final status = _statusCopy(inquiry.status);
    return Semantics(
      container: true,
      liveRegion: true,
      label: '${inquiry.plugin.name} plugin. $status',
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surfaceContainer,
            border: Border.all(
              color: Theme.of(context).colorScheme.outlineVariant,
            ),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        color: Theme.of(
                          context,
                        ).colorScheme.surfaceContainerHigh,
                        borderRadius: BorderRadius.circular(9),
                      ),
                      alignment: Alignment.center,
                      child: Icon(_icon, size: 18, color: _tone(context)),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            (inquiry.plugin.category ?? 'MANAGED PLUGIN')
                                .toUpperCase(),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppTypography.mono(
                              fontSize: 9,
                              color: Theme.of(
                                context,
                              ).colorScheme.onSurfaceVariant,
                            ),
                          ),
                          Text(
                            inquiry.plugin.displayName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppTypography.body(
                              fontSize: 14,
                              fontWeight: FontWeight.w700,
                              color: Theme.of(context).colorScheme.onSurface,
                            ),
                          ),
                          if (inquiry.plugin.developerName
                              case final publisher?)
                            Text(
                              publisher,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AppTypography.body(
                                fontSize: 12,
                                color: Theme.of(
                                  context,
                                ).colorScheme.onSurfaceVariant,
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      status,
                      style: AppTypography.body(
                        fontSize: 12,
                        color: _tone(context),
                      ),
                    ),
                  ],
                ),
                if (actionable) ...[
                  const SizedBox(height: 10),
                  Text(
                    online
                        ? 'Install this managed plugin?'
                        : 'Reconnect to respond to this request.',
                    style: AppTypography.body(
                      fontSize: 13,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 10),
                  LayoutBuilder(
                    builder: (context, constraints) {
                      final narrow = constraints.maxWidth < 300;
                      final buttons = [
                        AppButton(
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.secondary,
                          disabled: !online || acting,
                          onPressed: onCancel,
                          child: const Text('Cancel'),
                        ),
                        AppButton(
                          size: AppButtonSize.sm,
                          loading: acting,
                          disabled: !online,
                          onPressed: onInstall,
                          child: const Text('Install'),
                        ),
                      ];
                      return narrow
                          ? Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                buttons[1],
                                const SizedBox(height: 8),
                                buttons[0],
                              ],
                            )
                          : Row(
                              mainAxisAlignment: MainAxisAlignment.end,
                              children: [
                                buttons[0],
                                const SizedBox(width: 8),
                                buttons[1],
                              ],
                            );
                    },
                  ),
                ],
                if (inquiry.status == PluginInquiryStatus.authRequired &&
                    inquiry.appsNeedingAuth.isNotEmpty) ...[
                  const SizedBox(height: 10),
                  Text(
                    'Connect ${inquiry.appsNeedingAuth.map((app) => app.name).join(', ')} in ChatGPT Apps. This updates automatically.',
                    style: AppTypography.body(
                      fontSize: 13,
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }

  Color _tone(BuildContext context) => switch (inquiry.status) {
    PluginInquiryStatus.installed => AppThemePalette.of(context).accentStrong,
    PluginInquiryStatus.authRequired ||
    PluginInquiryStatus.stale => AppThemePalette.of(context).warningStrong,
    PluginInquiryStatus.failed ||
    PluginInquiryStatus.refused => AppThemePalette.of(context).danger,
    PluginInquiryStatus.expired ||
    PluginInquiryStatus.cancelled => AppThemePalette.of(context).inkMuted,
    _ => AppThemePalette.of(context).accentStrong,
  };

  IconData get _icon => switch (inquiry.status) {
    PluginInquiryStatus.installed => LucideIcons.check,
    PluginInquiryStatus.authRequired => LucideIcons.keyRound,
    PluginInquiryStatus.failed ||
    PluginInquiryStatus.stale => LucideIcons.triangleAlert,
    PluginInquiryStatus.expired ||
    PluginInquiryStatus.cancelled ||
    PluginInquiryStatus.refused => LucideIcons.x,
    _ => LucideIcons.packagePlus,
  };
}

String _statusCopy(PluginInquiryStatus status) => switch (status) {
  PluginInquiryStatus.pending => 'Approval needed',
  PluginInquiryStatus.installing => 'Installing…',
  PluginInquiryStatus.installed => 'Installed',
  PluginInquiryStatus.authRequired => 'Sign-in needed',
  PluginInquiryStatus.expired => 'Expired',
  PluginInquiryStatus.cancelled => 'Cancelled',
  PluginInquiryStatus.refused => 'Not allowed',
  PluginInquiryStatus.failed => 'Install failed',
  PluginInquiryStatus.stale => 'No longer available',
};
