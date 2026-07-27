import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/presence.dart';
import '../../../core/notifications/notification_permission.dart';
import '../../../shared/ui_kit.dart';
import '../../../shared/widgets/adaptive_selection_picker.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/confirmation_bottom_sheet.dart';
import '../../../shared/widgets/loading_shimmer.dart';
import '../../../shared/widgets/presence_stack.dart';
import '../../auth/domain/auth_models.dart';
import '../../settings/application/sound_pack_controller.dart';
import '../../settings/application/notification_permission_controller.dart';
import '../../settings/domain/sound_pack.dart';
import '../application/fleet_controller.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

abstract final class _FleetSectionMetrics {
  static const headerGap = 10.0;
  static const rowGap = 8.0;
  static const sectionGap = 28.0;
}

typedef FleetOpenPeon =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
    });

class FleetOverview extends ConsumerWidget {
  const FleetOverview({
    super.key,
    this.compact = false,
    required this.user,
    required this.onSignOut,
    this.onOpenPeon,
  });

  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;
  final FleetOpenPeon? onOpenPeon;

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
        onOpenPeon: onOpenPeon,
        presence: presence,
      ),
      loading: () =>
          _FleetLoading(compact: compact, user: user, onSignOut: onSignOut),
      error: (error, _) => _FleetError(
        message: error is FleetException
            ? error.message
            : 'Could not load your workspaces.',
        onRetry: ref.read(fleetControllerProvider.notifier).refresh,
      ),
    );
  }
}

class FleetOverviewLoading extends StatelessWidget {
  const FleetOverviewLoading({super.key, this.compact = false});

  final bool compact;

  @override
  Widget build(BuildContext context) {
    return _FleetLoadingLayout(
      compact: compact,
      settings: const _SettingsLoading(),
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
    this.onOpenPeon,
    required this.presence,
  });

  final List<WorkspaceFleet> workspaces;
  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;
  final Future<void> Function() onRefresh;
  final FleetOpenPeon? onOpenPeon;
  final PresenceState presence;

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: CustomScrollView(
        key: const Key('fleet-overview'),
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverPadding(
            padding: EdgeInsets.only(
              top: compact ? context.appSpacing.screenHorizontal : 28,
            ),
            sliver: SliverMainAxisGroup(
              slivers: [
                if (workspaces.isEmpty)
                  const SliverToBoxAdapter(
                    child: _FleetConstrainedContent(child: _EmptyFleet()),
                  )
                else
                  for (final workspace in workspaces) ...[
                    SliverToBoxAdapter(
                      child: _WorkspaceSection(
                        fleet: workspace,
                        presence: presence,
                        onOpenPeon: onOpenPeon,
                      ),
                    ),
                    const SliverToBoxAdapter(
                      child: SizedBox(height: _FleetSectionMetrics.sectionGap),
                    ),
                  ],
                SliverToBoxAdapter(
                  child: _FleetConstrainedContent(
                    key: const Key('fleet-screen-padding'),
                    bottomPadding: 48,
                    child: _SettingsSection(user: user, onSignOut: onSignOut),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FleetConstrainedContent extends StatelessWidget {
  const _FleetConstrainedContent({
    super.key,
    required this.child,
    this.bottomPadding = 0,
  });

  final Widget child;
  final double bottomPadding;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Padding(
          padding: EdgeInsets.fromLTRB(12, 0, 12, bottomPadding),
          child: child,
        ),
      ),
    );
  }
}

class _SettingsSection extends ConsumerWidget {
  const _SettingsSection({required this.user, required this.onSignOut});

  final OperatorIdentity user;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final soundPack = ref.watch(soundPackControllerProvider);
    final selectedPack = soundPack.value ?? SoundPack.peon;

    return Column(
      key: const Key('settings-section'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const AppSectionHeader(title: 'Settings'),
        const SizedBox(height: _FleetSectionMetrics.headerGap),
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
              trailing: _SettingValue(label: selectedLabel, expanded: expanded),
            );
          },
        ),
        const SizedBox(height: _FleetSectionMetrics.rowGap),
        const _NotificationSettingsRow(),
        const SizedBox(height: _FleetSectionMetrics.rowGap),
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
      trailing: SizedBox(
        width: 44,
        height: 32,
        child: FittedBox(
          fit: BoxFit.contain,
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
    return AppListTile(
      title: label,
      leading: Icon(leading, size: 20, color: AppColors.boneDim),
      trailing: trailing,
      onTap: onTap,
      titleMaxLines: 1,
      semanticsHint: 'Change $label setting',
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

class _WorkspaceSection extends StatelessWidget {
  const _WorkspaceSection({
    required this.fleet,
    required this.presence,
    this.onOpenPeon,
  });

  final WorkspaceFleet fleet;
  final PresenceState presence;
  final FleetOpenPeon? onOpenPeon;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: Key('workspace-${fleet.workspace.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FleetConstrainedContent(
          child: AppSectionHeader(title: fleet.workspace.name),
        ),
        const SizedBox(height: _FleetSectionMetrics.headerGap),
        if (fleet.peons.isEmpty)
          _FleetConstrainedContent(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Text(
                'No peons available',
                style: AppTypography.body(color: AppColors.boneDim),
              ),
            ),
          )
        else
          for (final peon in fleet.peons)
            _PeonRow(
              workspace: fleet.workspace,
              peon: peon,
              viewers: presence.viewersForPeon(
                workspaceId: fleet.workspace.id,
                peonId: peon.id,
              ),
              onOpen: onOpenPeon,
            ),
      ],
    );
  }
}

class _PeonRow extends StatelessWidget {
  const _PeonRow({
    required this.workspace,
    required this.peon,
    required this.viewers,
    this.onOpen,
  });

  final Workspace workspace;
  final Peon peon;
  final List<PresenceViewer> viewers;
  final FleetOpenPeon? onOpen;

  @override
  Widget build(BuildContext context) {
    final statusText = peon.online
        ? '${peon.activeSessions} active'
        : 'offline';
    return AppListTile(
      key: Key('peon-${peon.id}'),
      title: peon.displayName,
      leading: StatusDot(
        state: peon.online ? StatusDotState.online : StatusDotState.offline,
        semanticLabel: peon.online ? 'Online' : 'Offline',
        size: 9,
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
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
      onTap: onOpen == null
          ? null
          : () => onOpen!(context, workspaceId: workspace.id, peonId: peon.id),
      variant: AppListTileVariant.sectionSurface,
      titleMaxLines: 1,
      semanticsHint: 'Open this Peon',
    );
  }
}

class _FleetLoading extends StatelessWidget {
  const _FleetLoading({
    required this.compact,
    required this.user,
    required this.onSignOut,
  });

  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context) {
    return _FleetLoadingLayout(
      compact: compact,
      settings: _SettingsSection(user: user, onSignOut: onSignOut),
    );
  }
}

class _FleetLoadingLayout extends StatelessWidget {
  const _FleetLoadingLayout({required this.compact, required this.settings});

  final bool compact;
  final Widget settings;

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        SliverToBoxAdapter(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 760),
              child: Padding(
                padding: context.appSpacing.screenInsets(
                  top: compact ? context.appSpacing.screenHorizontal : 28,
                  bottom: 48,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const LoadingShimmer(
                      key: Key('fleet-loading'),
                      label: 'Loading workspaces',
                      child: _FleetSkeleton(),
                    ),
                    const SizedBox(height: _FleetSectionMetrics.sectionGap),
                    settings,
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SettingsLoading extends StatelessWidget {
  const _SettingsLoading();

  @override
  Widget build(BuildContext context) {
    return const LoadingShimmer(
      key: Key('settings-loading'),
      label: 'Loading settings',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: ShimmerBlock(width: 86, height: 17),
          ),
          SizedBox(height: _FleetSectionMetrics.headerGap),
          _FleetSkeletonRow(titleFraction: 0.34, trailingWidth: 54),
          SizedBox(height: _FleetSectionMetrics.rowGap),
          _FleetSkeletonRow(titleFraction: 0.48, trailingWidth: 42),
          SizedBox(height: _FleetSectionMetrics.rowGap),
          _FleetSkeletonRow(titleFraction: 0.58, trailingWidth: 62),
        ],
      ),
    );
  }
}

class _FleetSkeleton extends StatelessWidget {
  const _FleetSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: ShimmerBlock(width: 118, height: 17),
        ),
        SizedBox(height: _FleetSectionMetrics.headerGap),
        _FleetSkeletonRow(titleFraction: 0.42, trailingWidth: 58),
        SizedBox(height: _FleetSectionMetrics.rowGap),
        _FleetSkeletonRow(titleFraction: 0.56, trailingWidth: 46),
        SizedBox(height: _FleetSectionMetrics.rowGap),
        _FleetSkeletonRow(titleFraction: 0.36, trailingWidth: 52),
      ],
    );
  }
}

class _FleetSkeletonRow extends StatelessWidget {
  const _FleetSkeletonRow({
    required this.titleFraction,
    required this.trailingWidth,
  });

  final double titleFraction;
  final double trailingWidth;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 56,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
        child: Row(
          children: [
            const ShimmerBlock(
              width: 9,
              height: 9,
              borderRadius: BorderRadius.all(Radius.circular(999)),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: FractionallySizedBox(
                alignment: Alignment.centerLeft,
                widthFactor: titleFraction,
                child: const ShimmerBlock(width: double.infinity, height: 14),
              ),
            ),
            const SizedBox(width: 10),
            ShimmerBlock(width: trailingWidth, height: 11),
          ],
        ),
      ),
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
            AppButton(
              key: const Key('fleet-retry'),
              onPressed: onRetry,
              variant: AppButtonVariant.secondary,
              leading: const Icon(LucideIcons.refreshCw, size: 18),
              child: const Text('Try again'),
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
