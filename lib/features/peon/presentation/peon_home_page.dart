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
import '../../projects/projects.dart';
import '../../sessions/application/sessions_controller.dart';
import '../../sessions/domain/session_models.dart';
import '../../sessions/sessions.dart';
import 'peon_settings_page.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/spacing.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/loading_shimmer.dart';
import '../../../shared/widgets/status_dot.dart';

enum _PeonTab { work, stats, settings }

class PeonHomePage extends ConsumerStatefulWidget {
  const PeonHomePage({super.key, required this.workspace, required this.peon});

  final Workspace workspace;
  final Peon peon;

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
                        ),
                        const SliverToBoxAdapter(child: SizedBox(height: 18)),
                        SliverMainAxisGroup(
                          slivers: [
                            _PinnedSectionHeader(
                              child: _SectionHeader(
                                title: 'Sessions',
                                actionLabel: 'New session',
                                onPressed: () => Navigator.of(context).push(
                                  MaterialPageRoute<void>(
                                    builder: (_) =>
                                        SessionDetailPage.newSession(
                                          workspaceId: widget.workspace.id,
                                          peonId: widget.peon.id,
                                        ),
                                  ),
                                ),
                              ),
                            ),
                            SliverToBoxAdapter(
                              child: _SectionFrame(
                                paddingKey: const Key('peon-screen-padding'),
                                padding: context.appSpacing.screenInsets(
                                  top: 6,
                                  bottom: 32,
                                ),
                                child: SessionList(
                                  workspaceId: widget.workspace.id,
                                  peonId: widget.peon.id,
                                  onSessionSelected: (session) =>
                                      Navigator.of(context).push(
                                        MaterialPageRoute<void>(
                                          builder: (context) =>
                                              SessionDetailPage(
                                                session: session,
                                              ),
                                        ),
                                      ),
                                ),
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
  });

  final String workspaceId;
  final String peonId;
  final bool online;
  final bool canCreate;

  @override
  ConsumerState<_ProjectsSection> createState() => _ProjectsSectionState();
}

class _ProjectsSectionState extends ConsumerState<_ProjectsSection> {
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
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
              children: [
                Expanded(
                  child: TextButton.icon(
                    onPressed: () => setState(() => _expanded = !_expanded),
                    style: TextButton.styleFrom(
                      alignment: Alignment.centerLeft,
                      minimumSize: const Size(0, 16),
                      padding: EdgeInsets.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    icon: Icon(
                      _expanded
                          ? LucideIcons.chevronDown
                          : LucideIcons.chevronRight,
                      size: 11,
                      color: AppColors.boneFaint,
                    ),
                    label: Text(
                      'PROJECTS',
                      style: AppTypography.body(
                        fontSize: 9.5,
                        fontWeight: FontWeight.w500,
                        color: AppColors.boneFaint,
                        letterSpacing: 1.5,
                        height: 1,
                      ),
                    ),
                  ),
                ),
                if (widget.canCreate)
                  TextButton(
                    key: const Key('new-project-action'),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => NewProjectPage(scope: scope),
                      ),
                    ),
                    style: TextButton.styleFrom(
                      minimumSize: const Size(0, 16),
                      padding: EdgeInsets.zero,
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    child: Text(
                      '+ NEW PROJECT',
                      style: AppTypography.body(
                        fontSize: 9,
                        fontWeight: FontWeight.w500,
                        color: AppColors.boneDim,
                        letterSpacing: 1.2,
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
              padding: const EdgeInsets.fromLTRB(8, 6, 8, 0),
              child: projects.when(
                skipLoadingOnRefresh: true,
                data: (value) => _ProjectList(
                  state: value,
                  sessions: sessions.value?.sessions ?? const [],
                  activeSessions: activeSessions,
                  online: widget.online,
                  isOwner: widget.canCreate,
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

class _ProjectList extends StatelessWidget {
  const _ProjectList({
    required this.state,
    required this.sessions,
    required this.activeSessions,
    required this.online,
    required this.isOwner,
    required this.onRetry,
  });

  final ProjectsState state;
  final List<SessionSummary> sessions;
  final ActiveWorkspaceSessions? activeSessions;
  final bool online;
  final bool isOwner;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.catalog?.stale == true)
          const _ProjectsNotice(message: 'The project catalog may be stale.'),
        if (state.message case final message?)
          _ProjectsNotice(message: message, onRetry: onRetry),
        if (state.projects.isEmpty && state.isRefreshing)
          const _ProjectLoading()
        else if (state.projects.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 8),
            child: Text(
              'No projects on this peon yet.',
              style: AppTypography.body(
                fontSize: 12,
                color: AppColors.boneFaint,
              ),
            ),
          )
        else
          for (final project in state.projects)
            _ProjectRow(
              key: Key('project-${project.projectId}'),
              project: project,
              activeCount: _activeCount(project),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => ProjectDetailPage(
                    workspaceId: project.workspaceId,
                    peonId: project.peonId,
                    project: project,
                    online: online,
                    isOwner: isOwner,
                  ),
                ),
              ),
            ),
      ],
    );
  }

  int _activeCount(PeonProject project) {
    final authoritative = activeSessions;
    if (authoritative != null) {
      return authoritative.countForProject(
        peonId: project.peonId,
        projectId: project.projectId,
        projectKey: project.key,
      );
    }
    return sessions
        .where(
          (session) =>
              session.isRunning &&
              (session.projectId == project.projectId ||
                  session.projectKey == project.key),
        )
        .length;
  }
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
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const ShimmerBlock(
                  width: 8,
                  height: 8,
                  borderRadius: BorderRadius.all(Radius.circular(999)),
                ),
                const SizedBox(width: 7),
                ShimmerBlock(width: titleWidth, height: 13),
              ],
            ),
            const SizedBox(height: 7),
            Padding(
              padding: const EdgeInsets.only(left: 15),
              child: ShimmerBlock(width: detailWidth, height: 9),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProjectRow extends StatelessWidget {
  const _ProjectRow({
    super.key,
    required this.project,
    required this.activeCount,
    required this.onTap,
  });

  final PeonProject project;
  final int activeCount;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final active = activeCount > 0;
    return Material(
      color: Colors.transparent,
      borderRadius: const BorderRadius.all(Radius.circular(6)),
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radius.circular(6)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Semantics(
                      label: active ? 'Active project' : 'Inactive project',
                      child: ExcludeSemantics(
                        child: Container(
                          key: Key('project-status-${project.projectId}'),
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: active
                                ? AppColors.felBright
                                : AppColors.iron700,
                            shape: BoxShape.circle,
                            boxShadow: active
                                ? [
                                    BoxShadow(
                                      color: AppColors.fel.withValues(
                                        alpha: 0.95,
                                      ),
                                      blurRadius: 4,
                                    ),
                                    BoxShadow(
                                      color: AppColors.fel.withValues(
                                        alpha: 0.72,
                                      ),
                                      blurRadius: 11,
                                    ),
                                  ]
                                : null,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        project.displayName,
                        maxLines: 1,
                        overflow: TextOverflow.fade,
                        softWrap: false,
                        style: AppTypography.display(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 3),
                Padding(
                  padding: const EdgeInsets.only(left: 15),
                  child: Row(
                    children: [
                      Text(
                        '${project.memberCount} members',
                        style: AppTypography.body(
                          fontSize: 10.5,
                          color: AppColors.boneFaint,
                        ),
                      ),
                      Text(
                        '  •  ${project.sessionCount} sessions',
                        style: AppTypography.body(
                          fontSize: 10.5,
                          color: AppColors.boneFaint,
                        ),
                      ),
                      if (active) ...[
                        const Spacer(),
                        Text(
                          '$activeCount active',
                          style: AppTypography.body(
                            fontSize: 10.5,
                            color: AppColors.forge,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
            ),
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
      contentHeight: 56,
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
                color: selected ? AppColors.rowSurface : Colors.transparent,
                borderRadius: const BorderRadius.all(Radius.circular(8)),
              ),
              child: Icon(
                icon,
                size: 18,
                color: selected ? AppColors.felBright : AppColors.boneDim,
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
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final section = title.toLowerCase();
    return _SectionHeaderSurface(
      section: section,
      child: Row(
        children: [
          Expanded(
            child: Text(
              title.toUpperCase(),
              style: AppTypography.body(
                fontSize: 9.5,
                fontWeight: FontWeight.w500,
                color: AppColors.boneFaint,
                letterSpacing: 1.5,
                height: 1,
              ),
            ),
          ),
          TextButton(
            onPressed: onPressed,
            style: TextButton.styleFrom(
              minimumSize: const Size(0, 16),
              padding: EdgeInsets.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
            child: Text(
              '+ ${actionLabel.toUpperCase()}',
              style: AppTypography.body(
                fontSize: 9,
                fontWeight: FontWeight.w500,
                color: AppColors.boneDim,
                letterSpacing: 1.2,
                height: 1,
              ),
            ),
          ),
        ],
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
    return Container(
      key: Key('$section-section-header'),
      decoration: const BoxDecoration(
        color: AppColors.iron950,
        borderRadius: BorderRadius.all(Radius.circular(6)),
      ),
      child: Padding(
        key: Key('$section-section-header-padding'),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        child: child,
      ),
    );
  }
}

class _PinnedSectionHeader extends StatelessWidget {
  const _PinnedSectionHeader({required this.child});

  static const extent = 28.0;

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
    return SizedBox.expand(child: child);
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
    this.paddingKey,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Key? paddingKey;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 760),
        child: Padding(
          key: paddingKey,
          padding: padding,
          child: SizedBox(width: double.infinity, child: child),
        ),
      ),
    );
  }
}
