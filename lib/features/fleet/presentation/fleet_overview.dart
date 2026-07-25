import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/presence.dart';
import '../../../core/notifications/notification_permission.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/motion.dart';
import '../../../shared/design/spacing.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/adaptive_selection_picker.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/confirmation_bottom_sheet.dart';
import '../../../shared/widgets/overseer_logo.dart';
import '../../../shared/widgets/presence_stack.dart';
import '../../../shared/widgets/status_dot.dart';
import '../../../shared/widgets/surface.dart';
import '../../auth/domain/auth_models.dart';
import '../../settings/application/sound_pack_controller.dart';
import '../../settings/application/notification_permission_controller.dart';
import '../../settings/domain/sound_pack.dart';
import '../../peon/peon.dart';
import '../application/fleet_controller.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

abstract final class _FleetCardMetrics {
  static const padding = EdgeInsets.all(20);
  static const borderRadius = BorderRadius.all(Radius.circular(18));
  static const headerGap = 18.0;
  static const rowGap = 10.0;
  static const rowMinHeight = 64.0;
  static const rowPadding = EdgeInsets.symmetric(horizontal: 16, vertical: 8);
  static const rowBorderRadius = BorderRadius.all(Radius.circular(14));
}

class FleetOverview extends ConsumerWidget {
  const FleetOverview({
    super.key,
    this.compact = false,
    required this.user,
    required this.onSignOut,
  });

  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fleet = ref.watch(fleetControllerProvider);
    final presence = ref.watch(presenceProvider);
    return fleet.when(
      skipLoadingOnRefresh: true,
      data: (workspaces) => _FleetList(
        workspaces: workspaces,
        compact: compact,
        user: user,
        onSignOut: onSignOut,
        onRefresh: ref.read(fleetControllerProvider.notifier).refresh,
        presence: presence,
      ),
      loading: () => const _FleetLoading(),
      error: (error, _) => _FleetError(
        message: error is FleetException
            ? error.message
            : 'Could not load your workspaces.',
        onRetry: ref.read(fleetControllerProvider.notifier).refresh,
      ),
    );
  }
}

class _FleetList extends StatelessWidget {
  const _FleetList({
    required this.workspaces,
    required this.compact,
    required this.user,
    required this.onSignOut,
    required this.onRefresh,
    required this.presence,
  });

  final List<WorkspaceFleet> workspaces;
  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;
  final Future<void> Function() onRefresh;
  final PresenceState presence;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: CustomScrollView(
        key: const Key('fleet-overview'),
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 760),
                child: Padding(
                  key: const Key('fleet-screen-padding'),
                  padding: context.appSpacing.screenInsets(
                    top: compact ? 18 : 28,
                    bottom: 48,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      if (compact) ...[
                        const Center(child: OverseerLogo()),
                        const SizedBox(height: 20),
                      ],
                      if (workspaces.isEmpty)
                        const _EmptyFleet()
                      else
                        for (final workspace in workspaces) ...[
                          _WorkspaceCard(fleet: workspace, presence: presence),
                          const SizedBox(height: 16),
                        ],
                      const SizedBox(height: 8),
                      _SettingsCard(user: user, onSignOut: onSignOut),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsCard extends ConsumerWidget {
  const _SettingsCard({required this.user, required this.onSignOut});

  final OperatorIdentity user;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final soundPack = ref.watch(soundPackControllerProvider);
    final selectedPack = soundPack.value ?? SoundPack.peon;

    return Surface(
      key: const Key('settings-card'),
      padding: _FleetCardMetrics.padding,
      borderRadius: _FleetCardMetrics.borderRadius,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Settings', style: AppTypography.sectionTitle()),
          const SizedBox(height: _FleetCardMetrics.headerGap),
          AdaptiveSelectionPicker<SoundPack>(
            key: const Key('sound-pack-menu'),
            title: 'Sounds',
            value: selectedPack,
            options: [
              for (final pack in SoundPack.values)
                SelectionOption(value: pack, label: pack.label),
            ],
            onSelected: ref.read(soundPackControllerProvider.notifier).select,
            triggerBuilder: (context, selectedLabel, expanded, onTap) {
              return _SettingsRow(
                key: const Key('sound-setting'),
                leading: selectedPack == SoundPack.mute
                    ? LucideIcons.volumeX
                    : LucideIcons.volume2,
                label: 'Sounds',
                onTap: onTap,
                trailing: _SettingValue(
                  label: selectedLabel,
                  expanded: expanded,
                ),
              );
            },
          ),
          const SizedBox(height: _FleetCardMetrics.rowGap),
          const _NotificationSettingsRow(),
          const SizedBox(height: _FleetCardMetrics.rowGap),
          _SettingsRow(
            key: const Key('user-card'),
            leading: LucideIcons.circleUserRound,
            label: user.email,
            onTap: () async {
              final confirmed = await showAppConfirmationBottomSheet(
                context: context,
                title: 'Sign out?',
                message:
                    'You will need to sign in with GitHub again to access '
                    'your workspaces on this device.',
                confirmLabel: 'Sign out',
                destructive: true,
              );
              if (confirmed) await onSignOut();
            },
            trailing: Text(
              'Sign out',
              key: const Key('sign-out'),
              style: AppTypography.controlValue(),
            ),
          ),
        ],
      ),
    );
  }
}

class _NotificationSettingsRow extends ConsumerStatefulWidget {
  const _NotificationSettingsRow();

  @override
  ConsumerState<_NotificationSettingsRow> createState() =>
      _NotificationSettingsRowState();
}

class _NotificationSettingsRowState
    extends ConsumerState<_NotificationSettingsRow>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(notificationPermissionControllerProvider.notifier).refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(notificationPermissionControllerProvider);
    final enabled = status == NotificationPermissionStatus.enabled;
    final interactive =
        status != NotificationPermissionStatus.checking &&
        status != NotificationPermissionStatus.unavailable;

    return _SettingsRow(
      key: const Key('notification-setting'),
      leading: enabled ? LucideIcons.bellRing : LucideIcons.bell,
      label: 'Notifications',
      onTap: interactive ? () => _handleToggle(!enabled) : () {},
      trailing: Transform.scale(
        scale: 0.76,
        alignment: Alignment.centerRight,
        child: Switch.adaptive(
          key: const Key('notification-toggle'),
          value: enabled,
          onChanged: interactive ? _handleToggle : null,
          materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
          activeTrackColor: AppColors.fel,
          inactiveTrackColor: AppColors.iron700,
        ),
      ),
    );
  }

  Future<void> _handleToggle(bool desired) async {
    final status = ref.read(notificationPermissionControllerProvider);
    if (desired && status != NotificationPermissionStatus.enabled) {
      final result = await ref
          .read(notificationPermissionControllerProvider.notifier)
          .request();
      if (!mounted || result == NotificationPermissionStatus.enabled) return;
      await _showSettingsHelp(enabling: true);
      return;
    }
    if (!desired && status == NotificationPermissionStatus.enabled) {
      await _showSettingsHelp(enabling: false);
    }
  }

  Future<void> _showSettingsHelp({required bool enabling}) {
    return showAppBottomSheet<void>(
      context: context,
      builder: (sheetContext) => AppBottomSheet(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 20, 4, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  enabling ? 'Enable notifications' : 'Manage notifications',
                  key: const Key('notification-settings-title'),
                  textAlign: TextAlign.center,
                  style: AppTypography.sectionTitle(),
                ),
                const SizedBox(height: 14),
                Text(
                  enabling
                      ? 'The system permission prompt is no longer available. '
                            'Open this app’s settings, select Notifications, '
                            'and allow notifications there.'
                      : 'Notification access is controlled by the system. Open '
                            'this app’s settings to turn notifications off.',
                  key: const Key('notification-settings-description'),
                  textAlign: TextAlign.center,
                  style: AppTypography.body(
                    fontSize: 14,
                    height: 1.45,
                    color: AppColors.boneDim,
                  ),
                ),
                const SizedBox(height: 20),
                AppButton(
                  key: const Key('open-notification-settings'),
                  fullWidth: true,
                  size: AppButtonSize.lg,
                  borderRadius: AppMotion.optionShape,
                  onPressed: () async {
                    Navigator.of(sheetContext).pop();
                    await ref
                        .read(notificationPermissionControllerProvider.notifier)
                        .openSettings();
                  },
                  child: const Text('Open system settings'),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SettingsRow extends StatelessWidget {
  const _SettingsRow({
    super.key,
    required this.leading,
    required this.label,
    required this.onTap,
    required this.trailing,
  });

  final IconData leading;
  final String label;
  final VoidCallback onTap;
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.rowSurface,
      borderRadius: _FleetCardMetrics.rowBorderRadius,
      child: InkWell(
        onTap: onTap,
        borderRadius: _FleetCardMetrics.rowBorderRadius,
        overlayColor: WidgetStatePropertyAll(
          AppColors.fel.withValues(alpha: 0.1),
        ),
        child: Container(
          constraints: const BoxConstraints(
            minHeight: _FleetCardMetrics.rowMinHeight,
          ),
          padding: _FleetCardMetrics.rowPadding,
          child: Row(
            children: [
              Icon(leading, size: 24, color: AppColors.boneDim),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.controlLabel(),
                ),
              ),
              const SizedBox(width: 8),
              trailing,
            ],
          ),
        ),
      ),
    );
  }
}

class _SettingValue extends StatelessWidget {
  const _SettingValue({required this.label, required this.expanded});

  final String label;
  final bool expanded;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: AppMotion.fast,
          child: Text(
            label,
            key: ValueKey(label),
            style: AppTypography.controlValue(),
          ),
        ),
        const SizedBox(width: 4),
        AnimatedRotation(
          turns: expanded ? 0.5 : 0,
          duration: AppMotion.base,
          curve: AppMotion.iosQuick,
          child: const Icon(
            LucideIcons.chevronDown,
            size: 18,
            color: AppColors.boneDim,
          ),
        ),
      ],
    );
  }
}

class _WorkspaceCard extends StatelessWidget {
  const _WorkspaceCard({required this.fleet, required this.presence});

  final WorkspaceFleet fleet;
  final PresenceState presence;

  @override
  Widget build(BuildContext context) {
    return Surface(
      key: Key('workspace-${fleet.workspace.id}'),
      padding: _FleetCardMetrics.padding,
      borderRadius: _FleetCardMetrics.borderRadius,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(fleet.workspace.name, style: AppTypography.sectionTitle()),
          const SizedBox(height: _FleetCardMetrics.headerGap),
          if (fleet.peons.isEmpty)
            Text(
              'No peons available',
              style: AppTypography.body(color: AppColors.boneDim),
            )
          else
            for (var index = 0; index < fleet.peons.length; index++) ...[
              _PeonRow(
                workspace: fleet.workspace,
                peon: fleet.peons[index],
                viewers: presence.viewersForPeon(
                  workspaceId: fleet.workspace.id,
                  peonId: fleet.peons[index].id,
                ),
              ),
              if (index != fleet.peons.length - 1)
                const SizedBox(height: _FleetCardMetrics.rowGap),
            ],
        ],
      ),
    );
  }
}

class _PeonRow extends StatelessWidget {
  const _PeonRow({
    required this.workspace,
    required this.peon,
    required this.viewers,
  });

  final Workspace workspace;
  final Peon peon;
  final List<PresenceViewer> viewers;

  @override
  Widget build(BuildContext context) {
    final statusText = peon.online
        ? '${peon.activeSessions} active'
        : 'offline';
    return Semantics(
      container: true,
      label: '${peon.displayName}, $statusText',
      child: Material(
        color: AppColors.rowSurface,
        borderRadius: _FleetCardMetrics.rowBorderRadius,
        child: InkWell(
          key: Key('peon-${peon.id}'),
          borderRadius: _FleetCardMetrics.rowBorderRadius,
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (context) =>
                  PeonHomePage(workspace: workspace, peon: peon),
            ),
          ),
          child: Container(
            constraints: const BoxConstraints(
              minHeight: _FleetCardMetrics.rowMinHeight,
            ),
            padding: _FleetCardMetrics.rowPadding,
            child: Row(
              children: [
                StatusDot(
                  state: peon.online
                      ? StatusDotState.online
                      : StatusDotState.offline,
                  semanticLabel: peon.online ? 'Online' : 'Offline',
                  size: 9,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Text(
                    peon.displayName,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.entityTitle(),
                  ),
                ),
                const SizedBox(width: 12),
                Text(
                  statusText,
                  style: AppTypography.metadata(
                    color: peon.online ? AppColors.forge : AppColors.boneFaint,
                  ),
                ),
                if (viewers.isNotEmpty) ...[
                  const SizedBox(width: 8),
                  PresenceStack(
                    key: Key('peon-presence-${peon.id}'),
                    size: PresenceStackSize.xs,
                    viewers: [
                      for (final viewer in viewers)
                        PresencePerson(
                          userId: viewer.userId,
                          displayName: viewer.displayName,
                          avatarUrl: viewer.avatarUrl,
                        ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _FleetLoading extends StatelessWidget {
  const _FleetLoading();

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'Loading workspaces',
      child: const SizedBox.expand(key: Key('fleet-loading')),
    );
  }
}

class _FleetError extends StatelessWidget {
  const _FleetError({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              LucideIcons.cloudOff,
              size: 40,
              color: AppColors.boneDim,
            ),
            const SizedBox(height: 14),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(color: AppColors.boneDim),
            ),
            const SizedBox(height: 16),
            OutlinedButton.icon(
              key: const Key('fleet-retry'),
              onPressed: onRetry,
              icon: const Icon(LucideIcons.refreshCw),
              label: const Text('Try again'),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyFleet extends StatelessWidget {
  const _EmptyFleet();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.symmetric(vertical: 64),
      child: Column(
        children: [
          Icon(LucideIcons.serverOff, size: 44, color: AppColors.boneDim),
          SizedBox(height: 14),
          Text('No workspaces available'),
          SizedBox(height: 6),
          Text(
            'Your workspaces will appear here once you have access.',
            textAlign: TextAlign.center,
            style: TextStyle(color: AppColors.boneDim),
          ),
        ],
      ),
    );
  }
}
