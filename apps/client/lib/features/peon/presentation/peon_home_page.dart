import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';
import '../../ai_stats/ai_stats.dart';
import '../../fleet/application/fleet_controller.dart';
import '../../fleet/application/fleet_live_service.dart';
import '../../fleet/domain/fleet_models.dart';
import '../../projects/application/projects_controller.dart';
import '../../projects/domain/project_models.dart';
import '../../sessions/application/sessions_controller.dart';
import '../../sessions/domain/session_models.dart';
import '../../themes/domain/app_theme_package.dart';
import 'peon_settings_page.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/formatters/activity_timestamp.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/loading_shimmer.dart';
import '../../../shared/widgets/sidebar_status_edge.dart';
import '../../../shared/widgets/status_dot.dart';

enum _PeonTab { work, stats, settings }

typedef PeonOpenProject =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
      required PeonProject project,
      required bool online,
      required bool isOwner,
    });

typedef PeonOpenNewSession =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
      String? projectKey,
    });

typedef PeonOpenNewProject =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
    });

typedef PeonSessionListBuilder =
    Widget Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
    });

class PeonHomePage extends ConsumerStatefulWidget {
  const PeonHomePage({
    super.key,
    required this.workspace,
    required this.peon,
    this.onNewSession,
    this.onOpenProject,
    this.onNewProject,
    this.sessionListBuilder,
  });

  final Workspace workspace;
  final Peon peon;
  final PeonOpenNewSession? onNewSession;
  final PeonOpenProject? onOpenProject;
  final PeonOpenNewProject? onNewProject;
  final PeonSessionListBuilder? sessionListBuilder;

  @override
  ConsumerState<PeonHomePage> createState() => _PeonHomePageState();
}

class _PeonHomePageState extends ConsumerState<PeonHomePage> {
  late final FleetLiveService? _live;
  _PeonTab _tab = _PeonTab.work;

  @override
  void initState() {
    super.initState();
    _live = ref.read(fleetLiveServiceProvider);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _live?.setPresence(
        workspaceId: widget.workspace.id,
        location: PresenceLocation.peon(peonId: widget.peon.id),
      );
    });
  }

  @override
  void dispose() {
    _live?.setPresence(
      workspaceId: widget.workspace.id,
      location: const PresenceLocation.workspace(),
    );
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('peon-home-page'),
      body: SafeArea(
        top: false,
        bottom: _tab != _PeonTab.work,
        child: Column(
          children: [
            _PeonHeader(
              peon: widget.peon,
              selected: _tab,
              showStats:
                  widget.workspace.role == null ||
                  widget.workspace.role == 'owner',
              showSettings:
                  widget.workspace.role == null ||
                  widget.workspace.role == 'owner',
              onSelected: (tab) => setState(() => _tab = tab),
            ),
            Expanded(
              child: _tab == _PeonTab.settings
                  ? PeonSettingsPage(
                      workspace: widget.workspace,
                      peon: widget.peon,
                    )
                  : _tab == _PeonTab.stats
                  ? AiStatsPage(
                      workspaceId: widget.workspace.id,
                      peonId: widget.peon.id,
                      online: widget.peon.online,
                    )
                  : CustomScrollView(
                      slivers: [
                        _ProjectsSection(
                          workspaceId: widget.workspace.id,
                          peonId: widget.peon.id,
                          online: widget.peon.online,
                          canCreate:
                              widget.workspace.role == null ||
                              widget.workspace.role == 'owner',
                          onOpenProject: widget.onOpenProject,
                          onNewProject: widget.onNewProject,
                        ),
                        SliverMainAxisGroup(
                          slivers: [
                            _PinnedSectionHeader(
                              child: _SectionHeader(
                                title: 'Sessions',
                                actionLabel: 'New session',
                                onPressed: widget.onNewSession == null
                                    ? null
                                    : () => widget.onNewSession!(
                                        context,
                                        workspaceId: widget.workspace.id,
                                        peonId: widget.peon.id,
                                      ),
                              ),
                            ),
                            SliverLayoutBuilder(
                              builder: (context, constraints) {
                                final horizontalInset = math.max(
                                  0.0,
                                  (constraints.crossAxisExtent - 760) / 2,
                                );
                                return SliverPadding(
                                  padding: EdgeInsets.symmetric(
                                    horizontal: horizontalInset,
                                  ),
                                  sliver:
                                      widget.sessionListBuilder?.call(
                                        context,
                                        workspaceId: widget.workspace.id,
                                        peonId: widget.peon.id,
                                      ) ??
                                      const _SessionListFallback(),
                                );
                              },
                            ),
                            SliverToBoxAdapter(
                              child: Padding(
                                key: const Key('peon-screen-padding'),
                                padding: EdgeInsets.only(
                                  bottom:
                                      32 +
                                      MediaQuery.viewPaddingOf(context).bottom,
                                ),
                                child: const SizedBox.shrink(),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProjectsSection extends ConsumerStatefulWidget {
  const _ProjectsSection({
    required this.workspaceId,
    required this.peonId,
    required this.online,
    required this.canCreate,
    this.onOpenProject,
    this.onNewProject,
  });

  final String workspaceId;
  final String peonId;
  final bool online;
  final bool canCreate;
  final PeonOpenProject? onOpenProject;
  final PeonOpenNewProject? onNewProject;

  @override
  ConsumerState<_ProjectsSection> createState() => _ProjectsSectionState();
}

class _ProjectsSectionState extends ConsumerState<_ProjectsSection> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).extension<AppThemePalette>()!.package;
    final scope = ProjectsScope(
      workspaceId: widget.workspaceId,
      peonId: widget.peonId,
    );
    final projects = ref.watch(projectsControllerProvider(scope));
    final sessions = ref.watch(
      sessionsControllerProvider(
        SessionsScope(workspaceId: widget.workspaceId, peonId: widget.peonId),
      ),
    );
    final activeSessions = ref.watch(
      activeSessionsProvider.select(
        (state) => state.forWorkspace(widget.workspaceId),
      ),
    );
    return SliverMainAxisGroup(
      slivers: [
        _PinnedSectionHeader(
          child: _SectionHeaderSurface(
            section: 'projects',
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: TextButton.icon(
                    key: const Key('projects-toggle-action'),
                    onPressed: () => setState(() => _expanded = !_expanded),
                    style: TextButton.styleFrom(
                      alignment: Alignment.centerLeft,
                      minimumSize: Size.zero,
                      padding: EdgeInsets.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    icon: Icon(
                      _expanded
                          ? LucideIcons.chevronDown
                          : LucideIcons.chevronRight,
                      size: 11,
                      color: palette.inkMuted,
                    ),
                    label: Text(
                      'PROJECTS',
                      style: AppTypography.display(
                        fontSize: 8.8,
                        fontWeight: FontWeight.w600,
                        color: palette.inkMuted,
                        letterSpacing: 1.408,
                        height: 1,
                      ),
                    ),
                  ),
                ),
                if (widget.canCreate)
                  TextButton(
                    key: const Key('new-project-action'),
                    onPressed: widget.onNewProject == null
                        ? null
                        : () => widget.onNewProject!(
                            context,
                            workspaceId: widget.workspaceId,
                            peonId: widget.peonId,
                          ),
                    style: TextButton.styleFrom(
                      minimumSize: Size.zero,
                      padding: EdgeInsets.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text(
                      '+ NEW PROJECT',
                      style: AppTypography.display(
                        fontSize: 8.8,
                        fontWeight: FontWeight.w600,
                        color: palette.inkMuted,
                        letterSpacing: 1.408,
                        height: 1,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        if (_expanded)
          SliverToBoxAdapter(
            child: _SectionFrame(
              padding: EdgeInsets.zero,
              child: projects.when(
                skipLoadingOnRefresh: true,
                data: (value) => _ProjectList(
                  state: value,
                  sessions: sessions.value?.sessions ?? const [],
                  activeSessions: activeSessions,
                  online: widget.online,
                  isOwner: widget.canCreate,
                  onOpenProject: widget.onOpenProject,
                  onRetry: ref
                      .read(projectsControllerProvider(scope).notifier)
                      .refresh,
                ),
                loading: () => const _ProjectLoading(),
                error: (_, _) => _ProjectsNotice(
                  message: 'Could not open the project cache.',
                  onRetry: () =>
                      ref.invalidate(projectsControllerProvider(scope)),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class _ProjectList extends StatefulWidget {
  const _ProjectList({
    required this.state,
    required this.sessions,
    required this.activeSessions,
    required this.online,
    required this.isOwner,
    required this.onRetry,
    this.onOpenProject,
  });

  final ProjectsState state;
  final List<SessionSummary> sessions;
  final ActiveWorkspaceSessions? activeSessions;
  final bool online;
  final bool isOwner;
  final VoidCallback onRetry;
  final PeonOpenProject? onOpenProject;

  @override
  State<_ProjectList> createState() => _ProjectListState();
}

class _ProjectListState extends State<_ProjectList> {
  late Map<String, String> _fingerprints;
  Map<String, int> _flashRevisions = const {};

  @override
  void initState() {
    super.initState();
    _fingerprints = _projectFingerprints(widget);
  }

  @override
  void didUpdateWidget(covariant _ProjectList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final nextFingerprints = _projectFingerprints(widget);
    final nextFlashes = Map<String, int>.from(_flashRevisions);
    for (final entry in nextFingerprints.entries) {
      if (_fingerprints[entry.key] == entry.value) continue;
      nextFlashes[entry.key] = (nextFlashes[entry.key] ?? 0) + 1;
    }
    nextFlashes.removeWhere((key, _) => !nextFingerprints.containsKey(key));
    _fingerprints = nextFingerprints;
    _flashRevisions = nextFlashes;
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.state.catalog?.stale == true)
          const _ProjectsNotice(message: 'The project catalog may be stale.'),
        if (widget.state.message case final message?)
          _ProjectsNotice(message: message, onRetry: widget.onRetry),
        if (widget.state.projects.isEmpty && widget.state.isRefreshing)
          const _ProjectLoading()
        else if (widget.state.projects.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Text(
              'No projects on this peon yet.',
              style: AppTypography.body(
                fontSize: 12,
                color: AppColors.boneFaint,
              ),
            ),
          )
        else
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final project in widget.state.projects)
                  _ProjectRow(
                    key: Key('project-${project.projectId}'),
                    project: project,
                    activeCount: _activeCount(project),
                    lastActivity: _lastActivityFor(widget, project),
                    flashRevision: _flashRevisions[project.projectId] ?? 0,
                    onTap: widget.onOpenProject == null
                        ? null
                        : () => widget.onOpenProject!(
                            context,
                            workspaceId: project.workspaceId,
                            peonId: project.peonId,
                            project: project,
                            online: widget.online,
                            isOwner: widget.isOwner,
                          ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  int _activeCount(PeonProject project) {
    return _activeCountFor(widget, project);
  }

  int _activeCountFor(_ProjectList target, PeonProject project) {
    final authoritative = target.activeSessions;
    if (authoritative != null) {
      return authoritative.countForProject(
        peonId: project.peonId,
        projectId: project.projectId,
        projectKey: project.key,
      );
    }
    return target.sessions
        .where(
          (session) =>
              session.isRunning &&
              (session.projectId == project.projectId ||
                  session.projectKey == project.key),
        )
        .length;
  }

  double _lastActivityFor(_ProjectList target, PeonProject project) {
    var lastActivity = project.lastActivityMs ?? 0;
    for (final session in target.sessions) {
      final belongsToProject =
          session.projectId == project.projectId ||
          session.projectKey == project.key;
      if (belongsToProject && session.sortActivity > lastActivity) {
        lastActivity = session.sortActivity;
      }
    }
    return lastActivity;
  }

  Map<String, String> _projectFingerprints(_ProjectList target) => {
    for (final project in target.state.projects)
      project.projectId: [
        project.name ?? '',
        _activeCountFor(target, project),
        project.sessionCount,
        _lastActivityFor(target, project),
      ].join('|'),
  };
}

class _ProjectLoading extends StatelessWidget {
  const _ProjectLoading();

  @override
  Widget build(BuildContext context) {
    return const LoadingShimmer(
      key: Key('projects-loading-shimmer'),
      label: 'Loading projects',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ProjectSkeletonRow(titleWidth: 172, detailWidth: 132),
          _ProjectSkeletonRow(titleWidth: 214, detailWidth: 168),
          _ProjectSkeletonRow(titleWidth: 148, detailWidth: 116),
        ],
      ),
    );
  }
}

class _ProjectSkeletonRow extends StatelessWidget {
  const _ProjectSkeletonRow({
    required this.titleWidth,
    required this.detailWidth,
  });

  final double titleWidth;
  final double detailWidth;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 48,
      child: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ShimmerBlock(width: titleWidth, height: 13),
                const SizedBox(height: 7),
                ShimmerBlock(width: detailWidth, height: 9),
              ],
            ),
          ),
          const Positioned(
            top: 4,
            bottom: 4,
            left: 0,
            child: ShimmerBlock(width: 2, height: 40),
          ),
        ],
      ),
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({
    super.key,
    required this.project,
    required this.activeCount,
    required this.lastActivity,
    required this.flashRevision,
    this.onTap,
  });

  final PeonProject project;
  final int activeCount;
  final double lastActivity;
  final int flashRevision;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final active = activeCount > 0;
    final activity = formatActivityTimestamp(lastActivity);
    return Semantics(
      button: true,
      onTap: onTap,
      label: [
        active ? 'Active project' : 'Inactive project',
        project.displayName,
        '${project.sessionCount} sessions',
        if (active) '$activeCount active',
        ?activity,
      ].join(', '),
      child: ExcludeSemantics(
        child: SizedBox(
          height: 48,
          child: Stack(
            children: [
              Positioned.fill(
                child: Material(
                  color: Colors.transparent,
                  child: InkWell(onTap: onTap),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
                child: IgnorePointer(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        project.displayName,
                        maxLines: 1,
                        overflow: TextOverflow.fade,
                        softWrap: false,
                        style: AppTypography.display(
                          fontSize: 12.8,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Row(
                        children: [
                          Expanded(
                            child: Row(
                              children: [
                                Flexible(
                                  child: Text(
                                    key: Key(
                                      'project-session-count-${project.projectId}',
                                    ),
                                    '${project.sessionCount} sessions',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: AppTypography.body(
                                      fontSize: 9.6,
                                      color: AppColors.boneFaint,
                                    ),
                                  ),
                                ),
                                if (active) ...[
                                  const SizedBox(width: 6),
                                  Text(
                                    '•',
                                    style: AppTypography.body(
                                      fontSize: 9.6,
                                      color: AppColors.boneDim,
                                    ),
                                  ),
                                  const SizedBox(width: 6),
                                  Flexible(
                                    child: Text(
                                      key: Key(
                                        'project-active-count-${project.projectId}',
                                      ),
                                      '$activeCount active',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: AppTypography.body(
                                        fontSize: 9.6,
                                        color: AppColors.forge,
                                      ),
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                          if (activity != null) ...[
                            const SizedBox(width: 7),
                            Text(
                              key: Key('project-activity-${project.projectId}'),
                              activity,
                              style: AppTypography.body(
                                fontSize: 9.6,
                                color: AppColors.boneFaint,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
              ),
              Positioned(
                key: Key('project-status-position-${project.projectId}'),
                top: 4,
                bottom: 4,
                left: 0,
                child: SidebarStatusEdge(
                  key: Key('project-status-${project.projectId}'),
                  style: active
                      ? SidebarStatusEdgeStyle.running
                      : SidebarStatusEdgeStyle.idle,
                  semanticLabel: active ? 'Active project' : 'Inactive project',
                  flashRevision: flashRevision,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ProjectsNotice extends StatelessWidget {
  const _ProjectsNotice({required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: AppColors.forgeDeep.withValues(alpha: 0.16),
        borderRadius: const BorderRadius.all(Radius.circular(8)),
      ),
      child: Row(
        children: [
          const Icon(LucideIcons.cloudOff, size: 14, color: AppColors.ember),
          const SizedBox(width: 7),
          Expanded(
            child: Text(
              message,
              style: AppTypography.body(fontSize: 11, color: AppColors.ember),
            ),
          ),
          if (onRetry != null)
            TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _PeonHeader extends StatelessWidget {
  const _PeonHeader({
    required this.peon,
    required this.selected,
    required this.showStats,
    required this.showSettings,
    required this.onSelected,
  });

  final Peon peon;
  final _PeonTab selected;
  final bool showStats;
  final bool showSettings;
  final ValueChanged<_PeonTab> onSelected;

  @override
  Widget build(BuildContext context) {
    return AppNavigationBar(
      key: const Key('peon-navbar'),
      showBackButton: true,
      backButtonKey: const Key('peon-back'),
      contentPadding: const EdgeInsets.fromLTRB(8, 10, 12, 6),
      left: Row(
        children: [
          Flexible(
            fit: FlexFit.loose,
            child: Text(
              peon.displayName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.display(
                fontSize: 18,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(width: 8),
          StatusDot(
            state: peon.online ? StatusDotState.online : StatusDotState.offline,
            semanticLabel: peon.online ? 'Online' : 'Offline',
            size: 8,
          ),
        ],
      ),
      right: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _HeaderTab(
            icon: LucideIcons.pickaxe,
            label: 'Work',
            selected: selected == _PeonTab.work,
            onTap: () => onSelected(_PeonTab.work),
          ),
          if (showStats)
            _HeaderTab(
              icon: LucideIcons.chartNoAxesColumnIncreasing,
              label: 'Stats',
              selected: selected == _PeonTab.stats,
              onTap: () => onSelected(_PeonTab.stats),
            ),
          if (showSettings)
            _HeaderTab(
              icon: LucideIcons.settings,
              label: 'Settings',
              selected: selected == _PeonTab.settings,
              onTap: () => onSelected(_PeonTab.settings),
            ),
        ],
      ),
    );
  }
}

class _HeaderTab extends StatelessWidget {
  const _HeaderTab({
    required this.icon,
    required this.label,
    this.selected = false,
    this.onTap,
  });

  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      label: label,
      selected: selected,
      button: true,
      child: InkWell(
        key: Key('peon-tab-${label.toLowerCase()}'),
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radius.circular(8)),
        child: SizedBox(
          width: 40,
          height: 40,
          child: Center(
            child: Container(
              key: Key('peon-tab-${label.toLowerCase()}-surface'),
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: selected ? colors.primaryContainer : Colors.transparent,
                borderRadius: const BorderRadius.all(Radius.circular(8)),
              ),
              child: Icon(
                icon,
                size: 18,
                color: selected ? colors.primary : colors.onSurfaceVariant,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({
    required this.title,
    required this.actionLabel,
    required this.onPressed,
  });

  final String title;
  final String actionLabel;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).extension<AppThemePalette>()!.package;
    final section = title.toLowerCase();
    return _SectionHeaderSurface(
      section: section,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                title.toUpperCase(),
                style: AppTypography.display(
                  fontSize: 8.8,
                  fontWeight: FontWeight.w600,
                  color: palette.inkMuted,
                  letterSpacing: 1.408,
                  height: 1,
                ),
              ),
            ),
          ),
          TextButton(
            key: Key(
              '${actionLabel.toLowerCase().replaceAll(' ', '-')}-action',
            ),
            onPressed: onPressed,
            style: TextButton.styleFrom(
              minimumSize: Size.zero,
              padding: EdgeInsets.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(
              '+ ${actionLabel.toUpperCase()}',
              style: AppTypography.display(
                fontSize: 8.8,
                fontWeight: FontWeight.w600,
                color: palette.inkMuted,
                letterSpacing: 1.408,
                height: 1,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _SessionListFallback extends StatelessWidget {
  const _SessionListFallback();

  @override
  Widget build(BuildContext context) {
    return SliverToBoxAdapter(
      child: SizedBox(
        height: 160,
        child: Center(
          child: Text(
            'Session list unavailable in this context.',
            style: AppTypography.body(color: AppColors.boneFaint),
          ),
        ),
      ),
    );
  }
}

class _SectionHeaderSurface extends StatelessWidget {
  const _SectionHeaderSurface({required this.section, required this.child});

  final String section;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final palette = Theme.of(context).extension<AppThemePalette>()!.package;
    return Container(
      key: Key('$section-section-header'),
      decoration: BoxDecoration(
        color: palette.surfaceHover.withValues(alpha: 0.92),
        border: Border(bottom: BorderSide(color: palette.edge)),
      ),
      child: Padding(
        key: Key('$section-section-header-padding'),
        padding: const EdgeInsets.symmetric(horizontal: 12),
        child: child,
      ),
    );
  }
}

class _PinnedSectionHeader extends StatelessWidget {
  const _PinnedSectionHeader({required this.child});

  static const extent = 28.0;
  static const blurSigma = 12.0;

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return SliverPersistentHeader(
      pinned: true,
      delegate: _PinnedSectionHeaderDelegate(child: child),
    );
  }
}

class _PinnedSectionHeaderDelegate extends SliverPersistentHeaderDelegate {
  const _PinnedSectionHeaderDelegate({required this.child});

  final Widget child;

  @override
  double get minExtent => _PinnedSectionHeader.extent;

  @override
  double get maxExtent => _PinnedSectionHeader.extent;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return ClipRect(
      child: BackdropFilter(
        key: const Key('pinned-section-header-blur'),
        filter: ImageFilter.blur(
          sigmaX: _PinnedSectionHeader.blurSigma,
          sigmaY: _PinnedSectionHeader.blurSigma,
        ),
        child: SizedBox.expand(child: child),
      ),
    );
  }

  @override
  bool shouldRebuild(_PinnedSectionHeaderDelegate oldDelegate) {
    return oldDelegate.child != child;
  }
}

class _SectionFrame extends StatelessWidget {
  const _SectionFrame({
    required this.child,
    this.padding = const EdgeInsets.symmetric(horizontal: 8),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Padding(
          padding: padding,
          child: SizedBox(width: double.infinity, child: child),
        ),
      ),
    );
  }
}
