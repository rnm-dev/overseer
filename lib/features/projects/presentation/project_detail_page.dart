import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/user_avatar.dart';
import '../application/project_detail_controller.dart';
import '../application/project_files_controller.dart';
import '../domain/project_detail_models.dart';
import '../domain/project_models.dart';
import 'project_files_page.dart';
part 'project_detail_tabs.dart';

enum ProjectDetailTab { overview, sessions, files, settings }

enum _ProjectSettingsSection { general, skills, members }

typedef ProjectDetailNewSessionIntent =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
      required String projectKey,
    });

typedef ProjectDetailOpenFileIntent =
    void Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
      required String projectId,
      required String projectKey,
      required String path,
    });

typedef ProjectDetailSessionsBuilder =
    Widget Function(
      BuildContext context, {
      required String workspaceId,
      required String peonId,
      required String projectId,
      required String projectKey,
    });

class ProjectDetailPage extends ConsumerStatefulWidget {
  const ProjectDetailPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.project,
    required this.online,
    required this.isOwner,
    this.onNewSession,
    this.onOpenFile,
    this.sessionListBuilder,
  });

  final String workspaceId;
  final String peonId;
  final PeonProject project;
  final bool online;
  final bool isOwner;
  final ProjectDetailNewSessionIntent? onNewSession;
  final ProjectDetailOpenFileIntent? onOpenFile;
  final ProjectDetailSessionsBuilder? sessionListBuilder;

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
                onPressed: widget.online && widget.onNewSession != null
                    ? () => widget.onNewSession!(
                        context,
                        workspaceId: widget.workspaceId,
                        peonId: widget.peonId,
                        projectKey: project.key,
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
      sessionListBuilder: widget.sessionListBuilder,
    ),
    ProjectDetailTab.files => _FilesPane(
      scope: ProjectFilesScope(
        workspaceId: widget.workspaceId,
        peonId: widget.peonId,
        projectKey: state.project.key,
      ),
      onOpenFile: widget.onOpenFile == null
          ? null
          : (path) => widget.onOpenFile!(
              context,
              workspaceId: widget.workspaceId,
              peonId: widget.peonId,
              projectId: state.project.projectId,
              projectKey: state.project.key,
              path: path,
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
    required this.sessionListBuilder,
  });

  final String workspaceId;
  final String peonId;
  final PeonProject project;
  final ProjectDetailSessionsBuilder? sessionListBuilder;

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
              child: sessionListBuilder == null
                  ? const _ProjectSessionsEmptyFallback(
                      message: 'Session list unavailable in this context.',
                    )
                  : sessionListBuilder!(
                      context,
                      workspaceId: workspaceId,
                      peonId: peonId,
                      projectId: project.projectId,
                      projectKey: project.key,
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProjectSessionsEmptyFallback extends StatelessWidget {
  const _ProjectSessionsEmptyFallback({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return _EmptyPane(
      icon: LucideIcons.messagesSquare,
      title: 'Sessions not available',
      message: message,
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
  final ValueChanged<String>? onOpenFile;

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
