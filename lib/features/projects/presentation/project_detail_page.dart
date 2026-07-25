import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../sessions/sessions.dart';
import '../application/project_detail_controller.dart';
import '../application/project_files_controller.dart';
import '../domain/project_detail_models.dart';
import '../domain/project_models.dart';
import 'project_file_viewer_page.dart';
import 'project_files_page.dart';

enum ProjectDetailTab { overview, sessions, files, settings }

enum _ProjectSettingsSection { general, skills, members }

class ProjectDetailPage extends ConsumerStatefulWidget {
  const ProjectDetailPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.project,
    required this.online,
    required this.isOwner,
  });

  final String workspaceId;
  final String peonId;
  final PeonProject project;
  final bool online;
  final bool isOwner;

  @override
  ConsumerState<ProjectDetailPage> createState() => _ProjectDetailPageState();
}

class _ProjectDetailPageState extends ConsumerState<ProjectDetailPage> {
  ProjectDetailTab _tab = ProjectDetailTab.overview;

  ProjectDetailScope get _scope => ProjectDetailScope(
    project: widget.project,
    online: widget.online,
    isOwner: widget.isOwner,
  );

  void _select(ProjectDetailTab tab) {
    setState(() => _tab = tab);
    final controller = ref.read(
      projectDetailControllerProvider(_scope).notifier,
    );
    switch (tab) {
      case ProjectDetailTab.settings:
        controller.loadSettingsHub();
      case ProjectDetailTab.overview:
      case ProjectDetailTab.sessions:
      case ProjectDetailTab.files:
        break;
    }
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(projectDetailControllerProvider(_scope));
    final state = detail.value;
    final project = state?.project ?? widget.project;
    final tabs = <ProjectDetailTab>[
      ProjectDetailTab.overview,
      ProjectDetailTab.sessions,
      ProjectDetailTab.files,
      ProjectDetailTab.settings,
    ];
    return Scaffold(
      key: const Key('project-detail-page'),
      backgroundColor: AppColors.background,
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            AppNavigationBar(
              key: const Key('project-detail-navbar'),
              showBackButton: false,
              contentHeight: 58,
              contentPadding: const EdgeInsets.fromLTRB(4, 4, 8, 4),
              left: Row(
                children: [
                  IconButton(
                    tooltip: 'Back',
                    onPressed: () => Navigator.of(context).maybePop(),
                    constraints: const BoxConstraints.tightFor(
                      width: 48,
                      height: 48,
                    ),
                    icon: const Icon(
                      LucideIcons.arrowLeft,
                      size: 18,
                      color: AppColors.boneDim,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      project.displayName,
                      key: const Key('project-detail-title'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.display(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                ],
              ),
              right: _CompactHeaderAction(
                key: const Key('project-new-session'),
                onPressed: widget.online
                    ? () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => SessionDetailPage.newSession(
                            workspaceId: widget.workspaceId,
                            peonId: widget.peonId,
                            projectKey: project.key,
                          ),
                        ),
                      )
                    : null,
                label: 'New session',
              ),
            ),
            _ProjectTabs(tabs: tabs, selected: _tab, onSelected: _select),
            if (!widget.online)
              const _InlineNotice(
                message:
                    'This peon is offline. Cached project details remain available.',
              ),
            if (state?.message case final message?)
              _InlineNotice(
                message: message,
                error: true,
                onRetry: () => _retryCurrent(state!),
              ),
            Expanded(
              child: detail.when(
                loading: () => const _LoadingPane(),
                error: (_, _) => _ErrorPane(
                  onRetry: () =>
                      ref.invalidate(projectDetailControllerProvider(_scope)),
                ),
                data: (state) => Stack(
                  children: [
                    Positioned.fill(child: _body(state)),
                    if (state.loading)
                      const Positioned(
                        top: 12,
                        right: 16,
                        child: SizedBox.square(
                          dimension: 16,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.5,
                            color: AppColors.felBright,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(ProjectDetailState state) => switch (_tab) {
    ProjectDetailTab.overview => _OverviewPane(
      state: state,
      onRefresh: () => ref
          .read(projectDetailControllerProvider(_scope).notifier)
          .refreshOverview(),
      onOpenDocument: (path) => ref
          .read(projectDetailControllerProvider(_scope).notifier)
          .openDocumentation(path),
    ),
    ProjectDetailTab.sessions => _ProjectSessionsPane(
      workspaceId: widget.workspaceId,
      peonId: widget.peonId,
      project: state.project,
    ),
    ProjectDetailTab.files => _FilesPane(
      scope: ProjectFilesScope(
        workspaceId: widget.workspaceId,
        peonId: widget.peonId,
        projectKey: state.project.key,
      ),
      onOpenFile: (path) => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ProjectFileViewerPage(
            workspaceId: widget.workspaceId,
            peonId: widget.peonId,
            projectKey: state.project.key,
            projectId: state.project.projectId,
            path: path,
          ),
        ),
      ),
    ),
    ProjectDetailTab.settings => _SettingsHub(
      state: state,
      online: widget.online,
      isOwner: widget.isOwner,
      onSave: (settings) => ref
          .read(projectDetailControllerProvider(_scope).notifier)
          .saveSettings(settings),
      onMemberChanged: (member, enabled) => ref
          .read(projectDetailControllerProvider(_scope).notifier)
          .setMemberAccess(member, enabled),
    ),
  };

  void _retryCurrent(ProjectDetailState state) {
    final controller = ref.read(
      projectDetailControllerProvider(_scope).notifier,
    );
    switch (_tab) {
      case ProjectDetailTab.overview:
        controller.refreshOverview();
      case ProjectDetailTab.settings:
        controller.loadSettingsHub();
      case ProjectDetailTab.sessions:
      case ProjectDetailTab.files:
        break;
    }
  }
}

class _ProjectSessionsPane extends StatelessWidget {
  const _ProjectSessionsPane({
    required this.workspaceId,
    required this.peonId,
    required this.project,
  });

  final String workspaceId;
  final String peonId;
  final PeonProject project;

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      key: const Key('project-sessions-pane'),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
      child: _Surface(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _CardHeader(
              icon: LucideIcons.messagesSquare,
              title: 'Project sessions',
              subtitle: 'Cached and live sessions for this project.',
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 6, 6, 12),
              child: SessionList(
                workspaceId: workspaceId,
                peonId: peonId,
                projectId: project.projectId,
                projectKey: project.key,
                onSessionSelected: (session) => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => SessionDetailPage(session: session),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OverviewPane extends StatelessWidget {
  const _OverviewPane({
    required this.state,
    required this.onRefresh,
    required this.onOpenDocument,
  });

  final ProjectDetailState state;
  final VoidCallback onRefresh;
  final ValueChanged<String> onOpenDocument;

  @override
  Widget build(BuildContext context) {
    final listing = state.documentation;
    return ListView(
      key: const Key('project-overview-pane'),
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 28),
      children: [
        _Surface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _CardHeader(
                icon: LucideIcons.bookOpen,
                title: _breadcrumbs(state.documentationPath),
                subtitle:
                    'Documentation synced from this project’s docs folder.',
                action: IconButton(
                  key: const Key('project-docs-refresh'),
                  tooltip: 'Refresh documentation',
                  onPressed: state.loading ? null : onRefresh,
                  icon: const Icon(
                    LucideIcons.refreshCw,
                    size: 16,
                    color: AppColors.boneFaint,
                  ),
                ),
              ),
              if (state.documentationSource case final source?)
                _MarkdownDocument(source: source)
              else if (listing == null && state.loading)
                const _DocumentationSkeleton()
              else if (listing == null)
                const _EmptyPane(
                  icon: LucideIcons.bookOpen,
                  title: 'Documentation unavailable',
                  message: 'Refresh to try loading this project’s docs.',
                )
              else if (!listing.exists)
                const _EmptyPane(
                  icon: LucideIcons.bookOpen,
                  title: 'No documentation yet',
                  message:
                      'Add docs/index.md to the project to show documentation here.',
                )
              else if (listing.entries.isEmpty)
                const _EmptyPane(
                  icon: LucideIcons.folder,
                  title: 'Empty docs folder',
                  message: 'There are no documentation files yet.',
                )
              else
                for (final entry in listing.entries)
                  _DocumentationRow(
                    entry: entry,
                    onTap:
                        !entry.isDirectory &&
                            RegExp(
                              r'\.(md|markdown|mdx)$',
                              caseSensitive: false,
                            ).hasMatch(entry.name)
                        ? () => onOpenDocument('docs/${entry.name}')
                        : null,
                  ),
            ],
          ),
        ),
      ],
    );
  }
}

class _FilesPane extends ConsumerWidget {
  const _FilesPane({required this.scope, required this.onOpenFile});

  final ProjectFilesScope scope;
  final ValueChanged<String> onOpenFile;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final files = ref.watch(projectFilesControllerProvider(scope));
    return Padding(
      padding: const EdgeInsets.all(12),
      child: _Surface(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const _SectionTitle(title: 'Files'),
            Expanded(
              child: files.when(
                data: (value) => ProjectFileTreeView(
                  state: value,
                  onToggle: (path) => ref
                      .read(projectFilesControllerProvider(scope).notifier)
                      .toggleDirectory(path),
                  onRetry: (path) => ref
                      .read(projectFilesControllerProvider(scope).notifier)
                      .retryDirectory(path),
                  onOpenFile: onOpenFile,
                ),
                loading: () => const _LoadingPane(),
                error: (_, _) => _ErrorPane(
                  onRetry: () =>
                      ref.invalidate(projectFilesControllerProvider(scope)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SkillsPane extends StatelessWidget {
  const _SkillsPane({required this.state});

  final ProjectDetailState state;

  @override
  Widget build(BuildContext context) {
    final skills = state.skills;
    return ListView(
      key: const Key('project-skills-pane'),
      padding: const EdgeInsets.all(12),
      children: [
        _Surface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _CardHeader(
                icon: LucideIcons.sparkles,
                title: 'Project skills',
                subtitle: 'Skills discovered in this project.',
              ),
              if (skills == null)
                const _DocumentationSkeleton()
              else if (skills.isEmpty)
                const _EmptyPane(
                  icon: LucideIcons.sparkles,
                  title: 'No project skills',
                  message: 'This project does not expose any skills yet.',
                )
              else
                Padding(
                  padding: const EdgeInsets.all(12),
                  child: Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      for (final skill in skills) _SkillCard(skill: skill),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _MembersPane extends StatelessWidget {
  const _MembersPane({required this.state, required this.onChanged});

  final ProjectDetailState state;
  final void Function(WorkspaceMember, bool) onChanged;

  @override
  Widget build(BuildContext context) {
    final snapshot = state.members;
    final owners =
        snapshot?.members.where((member) => member.role == 'owner').length ?? 0;
    final members =
        snapshot?.members.where((member) => member.role == 'member').toList() ??
        const <WorkspaceMember>[];
    return ListView(
      key: const Key('project-members-pane'),
      padding: const EdgeInsets.all(12),
      children: [
        _Surface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _CardHeader(
                icon: LucideIcons.users,
                title: 'Project access',
                subtitle: 'Choose workspace members who can see this project.',
              ),
              if (snapshot == null)
                const _DocumentationSkeleton()
              else ...[
                if (owners > 0)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 10, 16, 10),
                    child: Text(
                      '$owners workspace owner${owners == 1 ? '' : 's'} always '
                      '${owners == 1 ? 'has' : 'have'} access',
                      style: AppTypography.mono(
                        fontSize: 10,
                        color: AppColors.boneFaint,
                      ),
                    ),
                  ),
                if (members.isEmpty)
                  const _EmptyPane(
                    icon: LucideIcons.users,
                    title: 'No workspace members',
                    message: 'Invite a member before assigning project access.',
                  )
                else
                  for (final member in members)
                    _MemberRow(
                      member: member,
                      enabled: _hasAccess(state, member.userId),
                      busy: state.saving,
                      onChanged: (enabled) => onChanged(member, enabled),
                    ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  bool _hasAccess(ProjectDetailState state, String userId) {
    final projects =
        state.members?.accessByMember[userId]?.projects ?? const [];
    return projects.any(
      (item) =>
          item.peonId == state.project.peonId &&
          (item.projectId == state.project.projectId ||
              item.projectKey == state.project.key),
    );
  }
}

class _SettingsHub extends StatefulWidget {
  const _SettingsHub({
    required this.state,
    required this.online,
    required this.isOwner,
    required this.onSave,
    required this.onMemberChanged,
  });

  final ProjectDetailState state;
  final bool online;
  final bool isOwner;
  final ValueChanged<ProjectSettings> onSave;
  final void Function(WorkspaceMember, bool) onMemberChanged;

  @override
  State<_SettingsHub> createState() => _SettingsHubState();
}

class _SettingsHubState extends State<_SettingsHub> {
  late _ProjectSettingsSection _section = widget.isOwner
      ? _ProjectSettingsSection.general
      : _ProjectSettingsSection.skills;

  @override
  Widget build(BuildContext context) {
    final sections = <_ProjectSettingsSection>[
      if (widget.isOwner) _ProjectSettingsSection.general,
      _ProjectSettingsSection.skills,
      if (widget.isOwner) _ProjectSettingsSection.members,
    ];
    return Column(
      key: const Key('project-settings-hub'),
      children: [
        Container(
          height: 48,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: const BoxDecoration(
            color: AppColors.iron950,
            border: Border(bottom: BorderSide(color: AppColors.iron800)),
          ),
          child: Row(
            children: [
              for (final section in sections)
                Padding(
                  padding: const EdgeInsets.only(right: 8),
                  child: _SettingsSectionButton(
                    section: section,
                    selected: _section == section,
                    onTap: () => setState(() => _section = section),
                  ),
                ),
            ],
          ),
        ),
        Expanded(
          child: switch (_section) {
            _ProjectSettingsSection.general => _SettingsPane(
              key: ValueKey(widget.state.settings?.key),
              state: widget.state,
              online: widget.online,
              onSave: widget.onSave,
            ),
            _ProjectSettingsSection.skills => _SkillsPane(state: widget.state),
            _ProjectSettingsSection.members => _MembersPane(
              state: widget.state,
              onChanged: widget.onMemberChanged,
            ),
          },
        ),
      ],
    );
  }
}

class _SettingsSectionButton extends StatelessWidget {
  const _SettingsSectionButton({
    required this.section,
    required this.selected,
    required this.onTap,
  });

  final _ProjectSettingsSection section;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final label = switch (section) {
      _ProjectSettingsSection.general => 'General',
      _ProjectSettingsSection.skills => 'Skills',
      _ProjectSettingsSection.members => 'Members',
    };
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        key: Key('project-settings-section-${section.name}'),
        onTap: onTap,
        borderRadius: BorderRadius.circular(6),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minWidth: 48, minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10),
            child: Center(
              child: Text(
                label,
                style: AppTypography.display(
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  color: selected ? AppColors.felBright : AppColors.boneFaint,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SettingsPane extends StatefulWidget {
  const _SettingsPane({
    super.key,
    required this.state,
    required this.online,
    required this.onSave,
  });

  final ProjectDetailState state;
  final bool online;
  final ValueChanged<ProjectSettings> onSave;

  @override
  State<_SettingsPane> createState() => _SettingsPaneState();
}

class _SettingsPaneState extends State<_SettingsPane> {
  late final TextEditingController _keyController;
  late final TextEditingController _nameController;
  late final TextEditingController _dirController;
  late final TextEditingController _metadataController;

  @override
  void initState() {
    super.initState();
    final settings = widget.state.settings;
    _keyController = TextEditingController(text: settings?.key ?? '');
    _nameController = TextEditingController(text: settings?.name ?? '');
    _dirController = TextEditingController(text: settings?.dir ?? '');
    _metadataController = TextEditingController(text: settings?.metadata ?? '');
  }

  @override
  void dispose() {
    _keyController.dispose();
    _nameController.dispose();
    _dirController.dispose();
    _metadataController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.state.settings == null) {
      return const _LoadingPane();
    }
    final canSave =
        widget.online &&
        !widget.state.saving &&
        _keyController.text.trim().isNotEmpty &&
        _nameController.text.trim().isNotEmpty &&
        _dirController.text.trim().isNotEmpty;
    return ListView(
      key: const Key('project-settings-pane'),
      padding: const EdgeInsets.all(12),
      children: [
        _Surface(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const _CardHeader(
                icon: LucideIcons.settings,
                title: 'Project settings',
                subtitle: 'Update the project identity and working directory.',
              ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    _Field(
                      label: 'KEY',
                      controller: _keyController,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 14),
                    _Field(
                      label: 'LABEL',
                      controller: _nameController,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 14),
                    _Field(
                      label: 'DIRECTORY',
                      controller: _dirController,
                      onChanged: (_) => setState(() {}),
                    ),
                    const SizedBox(height: 14),
                    _Field(
                      label: 'METADATA',
                      controller: _metadataController,
                      minLines: 5,
                      maxLines: 9,
                    ),
                  ],
                ),
              ),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: const BoxDecoration(
                  border: Border(top: BorderSide(color: AppColors.iron800)),
                ),
                child: Row(
                  children: [
                    if (widget.state.saved)
                      Text(
                        '⚡ Saved',
                        style: AppTypography.mono(
                          fontSize: 11,
                          color: AppColors.felBright,
                        ),
                      ),
                    const Spacer(),
                    AppButton(
                      key: const Key('project-settings-save'),
                      onPressed: canSave
                          ? () => widget.onSave(
                              ProjectSettings(
                                projectId:
                                    widget.state.settings?.projectId ??
                                    widget.state.project.projectId,
                                key: _keyController.text.trim(),
                                name: _nameController.text.trim(),
                                dir: _dirController.text.trim(),
                                metadata: _metadataController.text.isEmpty
                                    ? null
                                    : _metadataController.text,
                              ),
                            )
                          : null,
                      child: Text(
                        widget.state.saving ? 'Saving…' : 'Save changes',
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ProjectTabs extends StatelessWidget {
  const _ProjectTabs({
    required this.tabs,
    required this.selected,
    required this.onSelected,
  });

  final List<ProjectDetailTab> tabs;
  final ProjectDetailTab selected;
  final ValueChanged<ProjectDetailTab> onSelected;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 48,
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: AppColors.iron800)),
      ),
      child: ListView.separated(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        scrollDirection: Axis.horizontal,
        itemCount: tabs.length,
        separatorBuilder: (_, _) => const SizedBox(width: 12),
        itemBuilder: (context, index) {
          final tab = tabs[index];
          final active = tab == selected;
          return Semantics(
            selected: active,
            button: true,
            child: InkWell(
              key: Key('project-tab-${tab.name}'),
              onTap: () => onSelected(tab),
              child: Container(
                constraints: const BoxConstraints(minWidth: 48),
                alignment: Alignment.center,
                padding: const EdgeInsets.symmetric(horizontal: 4),
                decoration: BoxDecoration(
                  border: Border(
                    bottom: BorderSide(
                      width: 2,
                      color: active ? AppColors.felBright : Colors.transparent,
                    ),
                  ),
                ),
                child: Text(
                  _labelFor(tab),
                  style: AppTypography.display(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: active ? AppColors.felBright : AppColors.boneFaint,
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _CompactHeaderAction extends StatelessWidget {
  const _CompactHeaderAction({
    super.key,
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      enabled: onPressed != null,
      label: label,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onPressed,
        child: SizedBox(
          height: 48,
          child: Center(
            child: ExcludeSemantics(
              child: IgnorePointer(
                child: AppButton(
                  size: AppButtonSize.sm,
                  onPressed: onPressed,
                  child: Text(label),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _Surface extends StatelessWidget {
  const _Surface({required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppColors.rowSurface,
        border: Border.all(color: AppColors.iron800),
        borderRadius: BorderRadius.circular(8),
      ),
      child: ClipRRect(borderRadius: BorderRadius.circular(8), child: child),
    );
  }
}

class _CardHeader extends StatelessWidget {
  const _CardHeader({
    required this.icon,
    required this.title,
    required this.subtitle,
    this.action,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [AppColors.fel.withValues(alpha: 0.07), Colors.transparent],
        ),
        border: const Border(bottom: BorderSide(color: AppColors.iron800)),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: AppColors.fel.withValues(alpha: 0.1),
              border: Border.all(color: AppColors.fel.withValues(alpha: 0.22)),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(icon, size: 19, color: AppColors.felBright),
          ),
          const SizedBox(width: 11),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.display(
                    fontSize: 14,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: AppTypography.body(
                    fontSize: 11,
                    color: AppColors.boneFaint,
                  ),
                ),
              ],
            ),
          ),
          ?action,
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: AppColors.iron800)),
      ),
      child: Text(
        title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: AppTypography.display(
          fontSize: 12,
          fontWeight: FontWeight.w600,
          color: AppColors.boneDim,
        ),
      ),
    );
  }
}

class _SkillCard extends StatelessWidget {
  const _SkillCard({required this.skill});

  final ProjectSkill skill;

  @override
  Widget build(BuildContext context) {
    return ConstrainedBox(
      constraints: const BoxConstraints(minWidth: 250, maxWidth: 460),
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: AppColors.iron950.withValues(alpha: 0.4),
          border: Border.all(color: AppColors.iron800),
          borderRadius: BorderRadius.circular(7),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              skill.name,
              style: AppTypography.display(
                fontSize: 14,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              skill.description,
              style: AppTypography.body(
                fontSize: 13,
                color: AppColors.boneDim,
                height: 1.4,
              ),
            ),
            if (skill.path case final path?) ...[
              const SizedBox(height: 10),
              Text(
                path,
                style: AppTypography.mono(
                  fontSize: 10,
                  color: AppColors.boneFaint,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _MemberRow extends StatelessWidget {
  const _MemberRow({
    required this.member,
    required this.enabled,
    required this.busy,
    required this.onChanged,
  });

  final WorkspaceMember member;
  final bool enabled;
  final bool busy;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      constraints: const BoxConstraints(minHeight: 64),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: AppColors.iron800)),
      ),
      child: Row(
        children: [
          CircleAvatar(
            radius: 18,
            backgroundColor: AppColors.iron800,
            foregroundImage: member.avatarUrl?.isNotEmpty == true
                ? NetworkImage(member.avatarUrl!)
                : null,
            child: Text(
              member.displayName.characters.first.toUpperCase(),
              style: AppTypography.display(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: AppColors.felBright,
              ),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  member.displayName,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.display(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                if (member.githubLogin != null)
                  Text(
                    member.email,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.mono(
                      fontSize: 10,
                      color: AppColors.boneFaint,
                    ),
                  ),
              ],
            ),
          ),
          Switch.adaptive(
            value: enabled,
            onChanged: busy ? null : onChanged,
            activeTrackColor: AppColors.fel,
            activeThumbColor: AppColors.felBright,
          ),
        ],
      ),
    );
  }
}

class _DocumentationRow extends StatelessWidget {
  const _DocumentationRow({required this.entry, this.onTap});

  final ProjectDocumentationEntry entry;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 44),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: AppColors.iron800)),
        ),
        child: Row(
          children: [
            Icon(
              entry.isDirectory ? LucideIcons.folder : LucideIcons.fileText,
              size: 16,
              color: entry.isDirectory
                  ? AppColors.felDeep
                  : AppColors.boneFaint,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                entry.name,
                style: AppTypography.mono(
                  fontSize: 11,
                  color: AppColors.boneDim,
                ),
              ),
            ),
            Text(
              entry.isDirectory ? 'DIR' : 'FILE',
              style: AppTypography.mono(
                fontSize: 9,
                color: AppColors.boneFaint,
                letterSpacing: 1.1,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MarkdownDocument extends StatelessWidget {
  const _MarkdownDocument({required this.source});

  final String source;

  @override
  Widget build(BuildContext context) {
    final lines = source.split('\n');
    var inCode = false;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 18, 18, 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final line in lines)
            if (line.trim().startsWith('```'))
              Builder(
                builder: (_) {
                  inCode = !inCode;
                  return const SizedBox(height: 4);
                },
              )
            else
              Padding(
                padding: EdgeInsets.only(bottom: line.trim().isEmpty ? 8 : 5),
                child: SelectableText(
                  _stripMarkdown(line),
                  style: inCode
                      ? AppTypography.mono(
                          fontSize: 11,
                          color: AppColors.boneDim,
                          height: 1.45,
                        )
                      : line.startsWith('#')
                      ? AppTypography.display(
                          fontSize: _headingSize(line),
                          fontWeight: FontWeight.w700,
                          height: 1.25,
                        )
                      : AppTypography.body(
                          fontSize: 13,
                          color: AppColors.bone,
                          height: 1.5,
                        ),
                ),
              ),
        ],
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field({
    required this.label,
    required this.controller,
    this.minLines = 1,
    this.maxLines = 1,
    this.onChanged,
  });

  final String label;
  final TextEditingController controller;
  final int minLines;
  final int maxLines;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          label,
          style: AppTypography.body(
            fontSize: 9.5,
            fontWeight: FontWeight.w600,
            color: AppColors.boneFaint,
            letterSpacing: 1.2,
          ),
        ),
        const SizedBox(height: 6),
        Semantics(
          label: label,
          value: controller.text,
          textField: true,
          child: ExcludeSemantics(
            child: TextField(
              controller: controller,
              minLines: minLines,
              maxLines: maxLines,
              onChanged: onChanged,
              style: AppTypography.body(fontSize: 13, color: AppColors.bone),
              decoration: InputDecoration(
                filled: true,
                fillColor: AppColors.iron950,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 11,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: const BorderSide(color: AppColors.iron700),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: const BorderSide(color: AppColors.fel),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({
    required this.message,
    this.error = false,
    this.onRetry,
  });

  final String message;
  final bool error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      color: error
          ? AppColors.blood.withValues(alpha: 0.06)
          : AppColors.iron900,
      child: Row(
        children: [
          Expanded(
            child: Text(
              error ? '⚠ $message' : message,
              style: AppTypography.mono(
                fontSize: 10,
                color: error ? AppColors.blood : AppColors.boneFaint,
              ),
            ),
          ),
          if (onRetry != null)
            TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _EmptyPane extends StatelessWidget {
  const _EmptyPane({
    required this.icon,
    required this.title,
    required this.message,
  });

  final IconData icon;
  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 30, color: AppColors.boneFaint),
            const SizedBox(height: 12),
            Text(
              title,
              textAlign: TextAlign.center,
              style: AppTypography.display(
                fontSize: 14,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              message,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 11,
                color: AppColors.boneFaint,
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LoadingPane extends StatelessWidget {
  const _LoadingPane();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: SizedBox.square(
        dimension: 22,
        child: CircularProgressIndicator(
          strokeWidth: 1.7,
          color: AppColors.felBright,
        ),
      ),
    );
  }
}

class _DocumentationSkeleton extends StatelessWidget {
  const _DocumentationSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Padding(
      padding: EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _Skeleton(width: 150, height: 16),
          SizedBox(height: 12),
          _Skeleton(width: double.infinity, height: 9),
          SizedBox(height: 8),
          _Skeleton(width: 260, height: 9),
          SizedBox(height: 8),
          _Skeleton(width: 210, height: 9),
        ],
      ),
    );
  }
}

class _Skeleton extends StatelessWidget {
  const _Skeleton({required this.width, required this.height});

  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: AppColors.iron800,
        borderRadius: BorderRadius.circular(3),
      ),
    );
  }
}

class _ErrorPane extends StatelessWidget {
  const _ErrorPane({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: AppButton(
        onPressed: onRetry,
        variant: AppButtonVariant.secondary,
        child: const Text('Retry'),
      ),
    );
  }
}

String _labelFor(ProjectDetailTab tab) => switch (tab) {
  ProjectDetailTab.overview => 'Overview',
  ProjectDetailTab.sessions => 'Sessions',
  ProjectDetailTab.files => 'Files',
  ProjectDetailTab.settings => 'Settings',
};

String _breadcrumbs(String? path) {
  if (path == null || path == 'docs/index.md') return 'Project  ›  docs';
  return 'Project  ›  ${path.split('/').join('  ›  ')}';
}

double _headingSize(String line) {
  final count = line.characters.takeWhile((value) => value == '#').length;
  return switch (count) {
    1 => 22,
    2 => 18,
    3 => 16,
    _ => 14,
  };
}

String _stripMarkdown(String line) => line
    .replaceFirst(RegExp(r'^#{1,6}\s*'), '')
    .replaceAllMapped(
      RegExp(r'\[([^\]]+)\]\([^)]+\)'),
      (match) => match.group(1) ?? '',
    )
    .replaceAll(RegExp(r'[*_`~]'), '');
