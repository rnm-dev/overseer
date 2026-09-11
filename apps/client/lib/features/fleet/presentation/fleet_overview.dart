import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';
import '../../../core/notifications/notification_permission.dart';
import '../../../shared/ui_kit.dart';
import '../../../shared/widgets/adaptive_selection_picker.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/confirmation_bottom_sheet.dart';
import '../../../shared/widgets/loading_shimmer.dart';
import '../../../shared/widgets/presence_stack.dart';
import '../../auth/domain/auth_models.dart';
import '../../sessions/sessions.dart';
import '../../settings/application/sound_pack_controller.dart';
import '../../settings/application/tool_display_controller.dart';
import '../../themes/application/connection_theme_controller.dart';
import '../../settings/application/notification_permission_controller.dart';
import '../../settings/domain/sound_pack.dart';
import '../../settings/domain/tool_display_mode.dart';
import '../application/fleet_controller.dart';
import '../domain/fleet_models.dart';
import '../domain/fleet_repository.dart';

/// The composition root opts Windows into fluid width; other targets retain
/// the existing centered content limit.
final fleetOverviewMaxWidthProvider = Provider<double>((ref) => 760);

/// Enables workspace spacing for the Windows desktop layout.
final fleetWorkspaceSpacingProvider = Provider<bool>((ref) => false);

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

typedef FleetOpenSession =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
      required String sessionId,
    });

typedef FleetNewSession =
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
    this.onOpenSession,
    this.onNewSession,
  });

  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;
  final FleetOpenPeon? onOpenPeon;
  final FleetOpenSession? onOpenSession;
  final FleetNewSession? onNewSession;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fleet = ref.watch(fleetControllerProvider);
    final presence = ref.watch(presenceProvider);
    final activeSessions = ref.watch(activeSessionsProvider);
    return fleet.when(
      skipLoadingOnRefresh: true,
      data: (workspaces) => _FleetList(
        workspaces: workspaces,
        compact: compact,
        user: user,
        onSignOut: onSignOut,
        onRefresh: ref.read(fleetControllerProvider.notifier).refresh,
        onOpenPeon: onOpenPeon,
        onOpenSession: onOpenSession,
        onNewSession: onNewSession,
        presence: presence,
        activeSessions: activeSessions,
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
    this.onOpenSession,
    this.onNewSession,
    required this.presence,
    required this.activeSessions,
  });

  final List<WorkspaceFleet> workspaces;
  final bool compact;
  final OperatorIdentity user;
  final Future<void> Function() onSignOut;
  final Future<void> Function() onRefresh;
  final FleetOpenPeon? onOpenPeon;
  final FleetOpenSession? onOpenSession;
  final FleetNewSession? onNewSession;
  final PresenceState presence;
  final ActiveSessionsState activeSessions;

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
                        onOpenSession: onOpenSession,
                        onNewSession: onNewSession,
                        activeSessions: activeSessions.forWorkspace(
                          workspace.workspace.id,
                        ),
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

class _FleetConstrainedContent extends ConsumerWidget {
  const _FleetConstrainedContent({
    super.key,
    required this.child,
    this.bottomPadding = 0,
  });

  final Widget child;
  final double bottomPadding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: ref.watch(fleetOverviewMaxWidthProvider),
        ),
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
    final toolDisplay = ref.watch(toolDisplayControllerProvider);
    final selectedToolDisplay = toolDisplay.value ?? ToolDisplayMode.technical;
    final themeController = ref.watch(connectionThemeControllerProvider);

    return ListenableBuilder(
      listenable: themeController,
      builder: (context, _) => Column(
        key: const Key('settings-section'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const AppSectionHeader(title: 'Settings'),
          const SizedBox(height: _FleetSectionMetrics.headerGap),
          AdaptiveSelectionPicker<AppThemePackage>(
            key: const Key('theme-menu'),
            title: 'Theme',
            value: themeController.theme,
            options: [
              for (final theme in themeController.themes)
                SelectionOption(value: theme, label: theme.name),
            ],
            onSelected: themeController.select,
            triggerBuilder: (context, selectedLabel, expanded, onTap) {
              return _SettingsRow(
                key: const Key('theme-setting'),
                leading: LucideIcons.palette,
                label: 'Theme',
                onTap: onTap,
                trailing: _SettingValue(
                  label: selectedLabel,
                  expanded: expanded,
                ),
              );
            },
          ),
          const SizedBox(height: _FleetSectionMetrics.rowGap),
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
          const SizedBox(height: _FleetSectionMetrics.rowGap),
          AdaptiveSelectionPicker<ToolDisplayMode>(
            key: const Key('tool-display-menu'),
            title: 'Tool display',
            value: selectedToolDisplay,
            options: [
              for (final mode in ToolDisplayMode.values)
                SelectionOption(value: mode, label: mode.label),
            ],
            onSelected: ref.read(toolDisplayControllerProvider.notifier).select,
            triggerBuilder: (context, selectedLabel, expanded, onTap) {
              return _SettingsRow(
                key: const Key('tool-display-setting'),
                leading: LucideIcons.eye,
                label: 'Tool display',
                onTap: onTap,
                trailing: _SettingValue(
                  label: selectedLabel,
                  expanded: expanded,
                ),
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
              style: AppTypography.controlValue(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
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
    final colors = Theme.of(context).colorScheme;
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
            activeTrackColor: colors.primary,
            inactiveTrackColor: colors.outlineVariant,
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
      final disabled = await ref
          .read(notificationPermissionControllerProvider.notifier)
          .disable();
      if (!mounted || disabled) return;
      await _showSettingsHelp(enabling: false);
    }
  }

  Future<void> _showSettingsHelp({required bool enabling}) {
    return showAppBottomSheet<void>(
      context: context,
      builder: (sheetContext) {
        final colors = Theme.of(sheetContext).colorScheme;
        return AppBottomSheet(
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
                    style: AppTypography.sectionTitle(color: colors.onSurface),
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
                      color: colors.onSurfaceVariant,
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
                          .read(
                            notificationPermissionControllerProvider.notifier,
                          )
                          .openSettings();
                    },
                    child: const Text('Open system settings'),
                  ),
                ],
              ),
            ),
          ],
        );
      },
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
    final colors = Theme.of(context).colorScheme;
    return AppListTile(
      title: label,
      leading: Icon(leading, size: 20, color: colors.onSurfaceVariant),
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
    final colors = Theme.of(context).colorScheme;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedSwitcher(
          duration: AppMotion.fast,
          child: Text(
            label,
            key: ValueKey(label),
            style: AppTypography.controlValue(color: colors.onSurfaceVariant),
          ),
        ),
        const SizedBox(width: 4),
        AnimatedRotation(
          turns: expanded ? 0.5 : 0,
          duration: AppMotion.base,
          curve: AppMotion.iosQuick,
          child: Icon(
            LucideIcons.chevronDown,
            size: 18,
            color: colors.onSurfaceVariant,
          ),
        ),
      ],
    );
  }
}

class _WorkspaceSection extends ConsumerWidget {
  const _WorkspaceSection({
    required this.fleet,
    required this.presence,
    this.onOpenPeon,
    this.onOpenSession,
    this.onNewSession,
    required this.activeSessions,
  });

  final WorkspaceFleet fleet;
  final PresenceState presence;
  final FleetOpenPeon? onOpenPeon;
  final FleetOpenSession? onOpenSession;
  final FleetNewSession? onNewSession;
  final ActiveWorkspaceSessions? activeSessions;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final content = Column(
      key: Key('workspace-${fleet.workspace.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _FleetConstrainedContent(
          child: AppSectionHeader(title: fleet.workspace.name),
        ),
        const SizedBox(height: _FleetSectionMetrics.headerGap),
        if (fleet.peons.isEmpty)
          if (ref.watch(fleetWorkspaceSpacingProvider))
            Container(
              constraints: const BoxConstraints(minHeight: 44),
              alignment: Alignment.center,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: colors.onSurface.withValues(alpha: 0.05),
              ),
              child: Text(
                'No peons available',
                textAlign: TextAlign.center,
                style: AppTypography.body(color: colors.onSurfaceVariant),
              ),
            )
          else
            _FleetConstrainedContent(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Text(
                  'No peons available',
                  style: AppTypography.body(color: colors.onSurfaceVariant),
                ),
              ),
            )
        else
          for (final (index, peon) in fleet.peons.indexed) ...[
            _PeonGroup(
              workspace: fleet.workspace,
              peon: peon,
              viewers: presence.viewersForPeon(
                workspaceId: fleet.workspace.id,
                peonId: peon.id,
              ),
              onOpen: onOpenPeon,
              onOpenSession: onOpenSession,
              onNewSession: onNewSession,
              activeSessions: activeSessions,
            ),
            if (index < fleet.peons.length - 1)
              const SizedBox(height: _FleetSectionMetrics.rowGap),
          ],
      ],
    );
    if (!ref.watch(fleetWorkspaceSpacingProvider)) return content;
    return Container(
      margin: const EdgeInsets.symmetric(horizontal: 12),
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: content,
    );
  }
}

class _PeonGroup extends StatelessWidget {
  const _PeonGroup({
    required this.workspace,
    required this.peon,
    required this.viewers,
    required this.activeSessions,
    this.onOpen,
    this.onOpenSession,
    this.onNewSession,
  });

  static const _visibleSessionLimit = 3;

  final Workspace workspace;
  final Peon peon;
  final List<PresenceViewer> viewers;
  final ActiveWorkspaceSessions? activeSessions;
  final FleetOpenPeon? onOpen;
  final FleetOpenSession? onOpenSession;
  final FleetNewSession? onNewSession;

  @override
  Widget build(BuildContext context) {
    final sessions = peon.recentSessions
        .take(_visibleSessionLimit)
        .toList(growable: false);
    return Column(
      key: Key('peon-group-${peon.id}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _PeonRow(
          workspace: workspace,
          peon: peon,
          viewers: viewers,
          onOpen: onOpen,
          onNewSession: onNewSession,
        ),
        if (sessions.isNotEmpty)
          _AnimatedRecentSessionList(
            peonId: peon.id,
            sessions: sessions,
            activeSessions: activeSessions,
            onOpen: onOpenSession == null
                ? null
                : (session) => onOpenSession!(
                    context,
                    workspaceId: workspace.id,
                    peonId: peon.id,
                    sessionId: session.sessionId,
                  ),
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
    this.onNewSession,
  });

  final Workspace workspace;
  final Peon peon;
  final List<PresenceViewer> viewers;
  final FleetOpenPeon? onOpen;
  final FleetNewSession? onNewSession;

  @override
  Widget build(BuildContext context) {
    return AppListTile(
      key: Key('peon-${peon.id}'),
      title: peon.displayName,
      leading: StatusDot(
        state: peon.online ? StatusDotState.online : StatusDotState.offline,
        semanticLabel: peon.online ? 'Online' : 'Offline',
        size: 9,
      ),
      titleTrailing: viewers.isEmpty
          ? null
          : PresenceStack(
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
      trailing: onNewSession == null
          ? null
          : _PeonNewSessionAction(
              key: Key('peon-new-session-${peon.id}'),
              onPressed: () => onNewSession!(
                context,
                workspaceId: workspace.id,
                peonId: peon.id,
              ),
            ),
      onTap: onOpen == null
          ? null
          : () => onOpen!(context, workspaceId: workspace.id, peonId: peon.id),
      density: AppListTileDensity.compact,
      variant: AppListTileVariant.sectionSurface,
      titleMaxLines: 1,
      semanticsHint: 'Open this Peon',
    );
  }
}

class _PeonNewSessionAction extends StatelessWidget {
  const _PeonNewSessionAction({super.key, required this.onPressed});

  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return SizedBox(
      height: 44,
      child: TextButton(
        onPressed: onPressed,
        style: TextButton.styleFrom(
          minimumSize: Size.zero,
          padding: EdgeInsets.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        ),
        child: Text(
          '+ NEW SESSION',
          style: AppTypography.display(
            fontSize: 8.8,
            fontWeight: FontWeight.w600,
            color: colors.onSurfaceVariant,
            letterSpacing: 1.408,
            height: 1,
          ),
        ),
      ),
    );
  }
}

class _AnimatedRecentSessionList extends StatefulWidget {
  const _AnimatedRecentSessionList({
    required this.peonId,
    required this.sessions,
    required this.activeSessions,
    required this.onOpen,
  });

  final String peonId;
  final List<FleetRecentSession> sessions;
  final ActiveWorkspaceSessions? activeSessions;
  final ValueChanged<FleetRecentSession>? onOpen;

  @override
  State<_AnimatedRecentSessionList> createState() =>
      _AnimatedRecentSessionListState();
}

class _AnimatedRecentSessionListState
    extends State<_AnimatedRecentSessionList> {
  late Map<String, String> _fingerprints;
  Map<String, int> _flashRevisions = const {};
  Set<String> _appearing = const {};

  @override
  void initState() {
    super.initState();
    _fingerprints = _sessionFingerprints(widget.sessions);
  }

  @override
  void didUpdateWidget(covariant _AnimatedRecentSessionList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextFingerprints = _sessionFingerprints(widget.sessions);
    final nextFlashes = Map<String, int>.from(_flashRevisions);
    final appearing = <String>{};
    for (final entry in nextFingerprints.entries) {
      final previous = _fingerprints[entry.key];
      if (previous == null) appearing.add(entry.key);
      if (previous == null || previous != entry.value) {
        nextFlashes[entry.key] = (nextFlashes[entry.key] ?? 0) + 1;
      }
    }
    nextFlashes.removeWhere((key, _) => !nextFingerprints.containsKey(key));
    _fingerprints = nextFingerprints;
    _flashRevisions = nextFlashes;
    _appearing = appearing;
  }

  @override
  Widget build(BuildContext context) {
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final rowExtent = SessionWorkItem.extentFor(context);
    return AnimatedSize(
      duration: reduceMotion
          ? Duration.zero
          : const Duration(milliseconds: 240),
      curve: AppMotion.softSettle,
      alignment: Alignment.topCenter,
      child: SizedBox(
        key: Key('recent-sessions-${widget.peonId}'),
        height: widget.sessions.length * rowExtent,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            for (final (index, session) in widget.sessions.indexed)
              _FlyingRecentSessionPosition(
                key: ValueKey(session.sessionId),
                debugId: session.sessionId,
                top: index * rowExtent,
                rowExtent: rowExtent,
                reduceMotion: reduceMotion,
                child: _RecentSessionEntrance(
                  animate: _appearing.contains(session.sessionId),
                  reduceMotion: reduceMotion,
                  child: SessionWorkItem(
                    key: Key('session-${session.sessionId}'),
                    session: _sessionSummary(session),
                    authoritativeRunning:
                        widget.activeSessions?.contains(
                          peonId: session.peonId,
                          sessionId: session.sessionId,
                        ) ??
                        false,
                    flashRevision: _flashRevisions[session.sessionId] ?? 0,
                    onSelected: widget.onOpen == null
                        ? null
                        : (_) => widget.onOpen!(session),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Map<String, String> _sessionFingerprints(List<FleetRecentSession> sessions) =>
      {
        for (final session in sessions)
          session.sessionId: [
            session.status ?? '',
            session.lastActivityAt ?? 0,
            session.title ?? '',
            session.preview ?? '',
            session.hasOutstandingRequest ? 'waiting' : '',
            session.attentionUnread ? 'unread' : '',
          ].join('|'),
      };

  SessionSummary _sessionSummary(FleetRecentSession session) {
    return SessionSummary(
      workspaceId: session.workspaceId,
      peonId: session.peonId,
      sessionId: session.sessionId,
      status: session.status,
      projectKey: session.projectKey,
      projectId: session.projectId,
      title: session.title,
      promptPreview: session.promptPreview,
      preview: session.preview,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      syncedAt: session.syncedAt,
      attentionUnread: session.attentionUnread,
      attentionUpdatedAt: session.attentionUpdatedAt,
      hasOutstandingRequest: session.hasOutstandingRequest,
      lastRequestedAt: session.lastRequestedAt,
    );
  }
}

class _FlyingRecentSessionPosition extends StatefulWidget {
  const _FlyingRecentSessionPosition({
    super.key,
    required this.debugId,
    required this.top,
    required this.rowExtent,
    required this.reduceMotion,
    required this.child,
  });

  final String debugId;
  final double top;
  final double rowExtent;
  final bool reduceMotion;
  final Widget child;

  @override
  State<_FlyingRecentSessionPosition> createState() =>
      _FlyingRecentSessionPositionState();
}

class _FlyingRecentSessionPositionState
    extends State<_FlyingRecentSessionPosition>
    with SingleTickerProviderStateMixin {
  static const _flightDuration = Duration(milliseconds: 240);
  static const _flightCurve = Cubic(0.22, 1, 0.36, 1);

  late double _fromTop = widget.top;
  late double _toTop = widget.top;
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _flightDuration,
    value: 1,
  );

  double get _currentTop {
    final progress = _flightCurve.transform(_controller.value);
    return _fromTop + ((_toTop - _fromTop) * progress);
  }

  @override
  void didUpdateWidget(covariant _FlyingRecentSessionPosition oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.top == oldWidget.top) return;
    final currentTop = _currentTop;
    _fromTop = widget.reduceMotion ? widget.top : currentTop;
    _toTop = widget.top;
    if (widget.reduceMotion) {
      _controller.value = 1;
    } else {
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Positioned(
      top: 0,
      left: 0,
      right: 0,
      height: widget.rowExtent,
      child: AnimatedBuilder(
        animation: _controller,
        child: widget.child,
        builder: (context, child) => Transform.translate(
          key: Key('recent-session-position-${widget.debugId}'),
          offset: Offset(0, _currentTop),
          child: child,
        ),
      ),
    );
  }
}

class _RecentSessionEntrance extends StatefulWidget {
  const _RecentSessionEntrance({
    required this.animate,
    required this.reduceMotion,
    required this.child,
  });

  final bool animate;
  final bool reduceMotion;
  final Widget child;

  @override
  State<_RecentSessionEntrance> createState() => _RecentSessionEntranceState();
}

class _RecentSessionEntranceState extends State<_RecentSessionEntrance>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.base,
    value: widget.animate && !widget.reduceMotion ? 0 : 1,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_controller.value == 0) _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animation = CurvedAnimation(
      parent: _controller,
      curve: AppMotion.softSettle,
    );
    return FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, 0.12),
          end: Offset.zero,
        ).animate(animation),
        child: widget.child,
      ),
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
    final colors = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              LucideIcons.cloudOff,
              size: 40,
              color: colors.onSurfaceVariant,
            ),
            const SizedBox(height: 14),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(color: colors.onSurfaceVariant),
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
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 64),
      child: Column(
        children: [
          Icon(LucideIcons.serverOff, size: 44, color: colors.onSurfaceVariant),
          const SizedBox(height: 14),
          const Text('No workspaces available'),
          const SizedBox(height: 6),
          Text(
            'Your workspaces will appear here once you have access.',
            textAlign: TextAlign.center,
            style: TextStyle(color: colors.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}
