import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/active_sessions.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/formatters/activity_timestamp.dart';
import '../../fleet/application/fleet_controller.dart';
import '../../fleet/domain/fleet_models.dart';
import '../../projects/application/projects_controller.dart';
import '../../projects/domain/project_models.dart';
import '../../sessions/application/sessions_controller.dart';
import '../../sessions/domain/session_models.dart';

// Retain navigation choices when resizing replaces the wide/medium shell.
final _preferencesProvider = Provider((ref) => _SidebarPreferences());

class _SidebarPreferences {
  ProjectsScope? selected;
  bool grouped = true;
  final Set<String> collapsed = {};
}

/// Additive navigation for Fleet Overview, enabled only by Windows composition.
class DesktopFleetSidebar extends ConsumerStatefulWidget {
  const DesktopFleetSidebar({
    super.key,
    required this.onProject,
    required this.onSession,
    required this.onNewProject,
    required this.onNewSession,
  });

  final void Function(BuildContext, Workspace, Peon, PeonProject) onProject;
  final void Function(BuildContext, SessionSummary) onSession;
  final void Function(BuildContext, ProjectsScope) onNewProject;
  final void Function(BuildContext, ProjectsScope, String?) onNewSession;

  @override
  ConsumerState<DesktopFleetSidebar> createState() =>
      _DesktopFleetSidebarState();
}

class _DesktopFleetSidebarState extends ConsumerState<DesktopFleetSidebar> {
  ProjectsScope? get _selected => ref.read(_preferencesProvider).selected;
  set _selected(ProjectsScope? value) =>
      ref.read(_preferencesProvider).selected = value;
  bool get _grouped => ref.read(_preferencesProvider).grouped;
  set _grouped(bool value) => ref.read(_preferencesProvider).grouped = value;
  Set<String> get _collapsed => ref.read(_preferencesProvider).collapsed;

  @override
  Widget build(BuildContext context) {
    final fleet = ref.watch(fleetControllerProvider);
    return fleet.when(
      loading: () => const LinearProgressIndicator(),
      error: (_, _) => TextButton(
        onPressed: () => ref.invalidate(fleetControllerProvider),
        child: const Text('Retry sidebar'),
      ),
      data: (workspaces) {
        final choices = [
          for (final fleet in workspaces)
            for (final peon in fleet.peons)
              (workspace: fleet.workspace, peon: peon),
        ];
        if (choices.isEmpty) return const Text('No peons available');
        final current =
            choices
                .where(
                  (choice) =>
                      choice.workspace.id == _selected?.workspaceId &&
                      choice.peon.id == _selected?.peonId,
                )
                .firstOrNull ??
            choices.first;
        final scope = ProjectsScope(
          workspaceId: current.workspace.id,
          peonId: current.peon.id,
        );
        return Column(
          key: const Key('desktop-fleet-sidebar'),
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            DropdownButton<ProjectsScope>(
              key: const Key('sidebar-peon-selector'),
              value: scope,
              isExpanded: true,
              icon: const Icon(LucideIcons.chevronDown, size: 16),
              items: [
                for (final choice in choices)
                  DropdownMenuItem(
                    value: ProjectsScope(
                      workspaceId: choice.workspace.id,
                      peonId: choice.peon.id,
                    ),
                    child: Text(
                      '${choice.workspace.name} / ${choice.peon.displayName}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.body(fontSize: 12),
                    ),
                  ),
              ],
              onChanged: (value) => setState(() {
                _selected = value;
                _collapsed.clear();
              }),
            ),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Projects & chats',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 12),
                  ),
                ),
                PopupMenuButton<bool>(
                  tooltip: 'Chat list display',
                  icon: const Icon(LucideIcons.list, size: 16),
                  initialValue: _grouped,
                  itemBuilder: (_) => const [
                    PopupMenuItem(value: true, child: Text('Group by project')),
                    PopupMenuItem(value: false, child: Text('Flat list')),
                  ],
                  onSelected: (value) => setState(() => _grouped = value),
                ),
                IconButton(
                  tooltip: 'New project',
                  icon: const Icon(LucideIcons.folderPlus, size: 16),
                  onPressed: () => widget.onNewProject(context, scope),
                ),
              ],
            ),
            Expanded(
              child: _lists(context, current.workspace, current.peon, scope),
            ),
          ],
        );
      },
    );
  }

  Widget _lists(
    BuildContext context,
    Workspace workspace,
    Peon peon,
    ProjectsScope scope,
  ) {
    final projectsAsync = ref.watch(projectsControllerProvider(scope));
    final sessionScope = SessionsScope(
      workspaceId: workspace.id,
      peonId: peon.id,
    );
    final sessionsAsync = ref.watch(sessionsControllerProvider(sessionScope));
    final projects =
        [...?projectsAsync.value?.projects.where((project) => !project.deleted)]
          ..sort(
            (a, b) => a.displayName.toLowerCase().compareTo(
              b.displayName.toLowerCase(),
            ),
          );
    final state = sessionsAsync.value;
    final sessions = [...?state?.sessions.take(state.visibleCount)]
      ..sort((a, b) => b.sortActivity.compareTo(a.sortActivity));
    final active = ref.watch(activeSessionsProvider).forWorkspace(workspace.id);
    bool belongs(SessionSummary session, PeonProject project) =>
        session.projectId?.isNotEmpty == true
        ? session.projectId == project.projectId
        : session.projectKey == project.key;
    final children = <Widget>[];
    if (projectsAsync.isLoading || sessionsAsync.isLoading) {
      children.add(const LinearProgressIndicator());
    }
    if (projectsAsync.hasError || projectsAsync.value?.message != null) {
      children.add(
        TextButton(
          onPressed: () => ref.invalidate(projectsControllerProvider(scope)),
          child: const Text('Retry projects'),
        ),
      );
    }
    if (sessionsAsync.hasError || state?.message != null) {
      children.add(
        TextButton(
          onPressed: () =>
              ref.invalidate(sessionsControllerProvider(sessionScope)),
          child: const Text('Retry chats'),
        ),
      );
    }
    if (state?.catalogStale == true) {
      children.add(
        const Text(
          'Chat catalog may be out of date.',
          style: TextStyle(fontSize: 11),
        ),
      );
    }
    if (_grouped) {
      for (final project in projects) {
        children.addAll(
          _group(
            context,
            scope,
            project.projectId,
            project.displayName,
            sessions.where((s) => belongs(s, project)).toList(),
            active,
            onOpen: () => widget.onProject(context, workspace, peon, project),
            projectKey: project.key,
          ),
        );
      }
      // Keep chats whose project is missing or deleted accessible as well.
      final other = sessions
          .where((s) => !projects.any((p) => belongs(s, p)))
          .toList();
      children.addAll(
        _group(context, scope, '__other__', 'Other chats', other, active),
      );
    } else {
      children.add(_heading('Projects', '_projects'));
      if (!_collapsed.contains('_projects')) {
        for (final project in projects) {
          children.add(
            _SidebarRow(
              title: project.displayName,
              detail: '${project.sessionCount} sessions',
              onTap: () => widget.onProject(context, workspace, peon, project),
              color:
                  (active?.countForProject(
                            peonId: peon.id,
                            projectId: project.projectId,
                            projectKey: project.key,
                          ) ??
                          project.activeCount) >
                      0
                  ? Theme.of(context).colorScheme.primary
                  : null,
            ),
          );
        }
        if (projects.isEmpty && !projectsAsync.isLoading) {
          children.add(
            const Text('No projects', style: TextStyle(fontSize: 11)),
          );
        }
      }
      children.add(
        _heading(
          'Sessions',
          '_sessions',
          onNew: () => widget.onNewSession(context, scope, null),
        ),
      );
      if (!_collapsed.contains('_sessions')) {
        children.addAll(_sessionRows(context, sessions, active));
      }
    }
    if (state?.hasMore == true) {
      children.add(
        TextButton(
          onPressed: state!.isLoadingMore
              ? null
              : () => ref
                    .read(sessionsControllerProvider(sessionScope).notifier)
                    .loadMore(),
          child: Text(state.isLoadingMore ? 'Loading…' : 'Load older chats'),
        ),
      );
    }
    return ListView(
      key: ValueKey('sidebar-list-${workspace.id}-${peon.id}'),
      padding: EdgeInsets.zero,
      children: children,
    );
  }

  List<Widget> _group(
    BuildContext context,
    ProjectsScope scope,
    String id,
    String title,
    List<SessionSummary> sessions,
    ActiveWorkspaceSessions? active, {
    VoidCallback? onOpen,
    String? projectKey,
  }) => [
    _heading(
      title,
      id,
      onOpen: onOpen,
      onNew: () => widget.onNewSession(context, scope, projectKey),
    ),
    if (!_collapsed.contains(id)) ..._sessionRows(context, sessions, active),
  ];

  Widget _heading(
    String title,
    String id, {
    VoidCallback? onOpen,
    VoidCallback? onNew,
  }) {
    final collapsed = _collapsed.contains(id);
    void toggle() => setState(() {
      if (collapsed) {
        _collapsed.remove(id);
      } else {
        _collapsed.add(id);
      }
    });
    return ColoredBox(
      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: .05),
      child: Row(
        children: [
          IconButton(
            tooltip: '${collapsed ? 'Expand' : 'Collapse'} $title',
            constraints: const BoxConstraints.tightFor(width: 28, height: 32),
            padding: EdgeInsets.zero,
            icon: Icon(
              collapsed ? LucideIcons.chevronRight : LucideIcons.chevronDown,
              size: 14,
            ),
            onPressed: toggle,
          ),
          Expanded(
            child: InkWell(
              onTap: onOpen ?? toggle,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ),
          ),
          if (onNew != null)
            IconButton(
              tooltip: 'New chat in $title',
              constraints: const BoxConstraints.tightFor(width: 28, height: 32),
              padding: EdgeInsets.zero,
              icon: const Icon(LucideIcons.plus, size: 15),
              onPressed: onNew,
            ),
        ],
      ),
    );
  }

  List<Widget> _sessionRows(
    BuildContext context,
    List<SessionSummary> sessions,
    ActiveWorkspaceSessions? active,
  ) => [
    if (sessions.isEmpty)
      const Padding(
        padding: EdgeInsets.all(8),
        child: Text('No chats', style: TextStyle(fontSize: 11)),
      ),
    for (final session in sessions)
      _SidebarRow(
        key: ValueKey('sidebar-chat-${session.sessionId}'),
        title: session.displayTitle,
        detail:
            session.displayPreview ??
            formatActivityTimestamp(session.sortActivity) ??
            '',
        color:
            (active?.contains(
                  peonId: session.peonId,
                  sessionId: session.sessionId,
                ) ??
                session.isRunning)
            ? Theme.of(context).colorScheme.primary
            : session.attentionUnread
            ? AppThemePalette.of(context).warning
            : null,
        onTap: () => widget.onSession(context, session),
      ),
  ];
}

class _SidebarRow extends StatelessWidget {
  const _SidebarRow({
    super.key,
    required this.title,
    required this.detail,
    required this.onTap,
    this.color,
  });
  final String title;
  final String detail;
  final VoidCallback onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: title,
    child: InkWell(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.fromLTRB(8, 4, 4, 4),
        decoration: BoxDecoration(
          border: Border(
            left: BorderSide(
              width: 2,
              color: color ?? Theme.of(context).colorScheme.outlineVariant,
            ),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                fontSize: 12,
                fontWeight: FontWeight.w500,
              ),
            ),
            if (detail.isNotEmpty)
              Text(
                detail,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppTypography.body(
                  fontSize: 10,
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
          ],
        ),
      ),
    ),
  );
}
