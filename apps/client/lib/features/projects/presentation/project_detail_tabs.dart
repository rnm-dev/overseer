part of 'project_detail_page.dart';

String _breadcrumbs(String? path) {
  if (path == null || path == 'docs/index.md') return 'Project  ›  docs';
  return 'Project  ›  ${path.split('/').join('  ›  ')}';
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
    final colors = Theme.of(context).colorScheme;
    return Container(
      height: 48,
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.outlineVariant)),
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
                      color: active ? colors.primary : Colors.transparent,
                    ),
                  ),
                ),
                child: Text(
                  _labelFor(tab),
                  style: AppTypography.display(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: active ? colors.primary : colors.onSurfaceVariant,
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
    final colors = Theme.of(context).colorScheme;
    return IconButton(
      tooltip: label,
      onPressed: onPressed,
      constraints: const BoxConstraints.tightFor(width: 44, height: 44),
      style: IconButton.styleFrom(
        minimumSize: const Size.square(44),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: colors.primary,
        disabledForegroundColor: colors.onSurfaceVariant,
      ),
      icon: Icon(LucideIcons.plus, size: 20),
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
        color: AppThemePalette.of(context).surfaceRaised,
        border: Border.all(color: AppThemePalette.of(context).surfaceHover),
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
  });

  final IconData icon;
  final String title;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            AppThemePalette.of(context).accent.withValues(alpha: 0.07),
            Colors.transparent,
          ],
        ),
        border: Border(
          bottom: BorderSide(color: AppThemePalette.of(context).surfaceHover),
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: AppThemePalette.of(context).accent.withValues(alpha: 0.1),
              border: Border.all(
                color: AppThemePalette.of(
                  context,
                ).accent.withValues(alpha: 0.22),
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(
              icon,
              size: 19,
              color: AppThemePalette.of(context).accentStrong,
            ),
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
                    color: AppThemePalette.of(context).inkFaint,
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
          color: AppThemePalette.of(context).surface.withValues(alpha: 0.4),
          border: Border.all(color: AppThemePalette.of(context).surfaceHover),
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
                color: AppThemePalette.of(context).inkMuted,
                height: 1.4,
              ),
            ),
            if (skill.path case final path?) ...[
              const SizedBox(height: 10),
              Text(
                path,
                style: AppTypography.mono(
                  fontSize: 10,
                  color: AppThemePalette.of(context).inkFaint,
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
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: AppThemePalette.of(context).surfaceHover),
        ),
      ),
      child: Row(
        children: [
          UserAvatar(
            label: member.displayName,
            src: member.avatarUrl,
            size: UserAvatarSize.lg,
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
                      color: AppThemePalette.of(context).inkFaint,
                    ),
                  ),
              ],
            ),
          ),
          Switch.adaptive(
            value: enabled,
            onChanged: busy ? null : onChanged,
            activeTrackColor: AppThemePalette.of(context).accent,
            activeThumbColor: AppThemePalette.of(context).accentStrong,
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
        decoration: BoxDecoration(
          border: Border(
            top: BorderSide(color: AppThemePalette.of(context).surfaceHover),
          ),
        ),
        child: Row(
          children: [
            Icon(
              entry.isDirectory ? LucideIcons.folder : LucideIcons.fileText,
              size: 16,
              color: entry.isDirectory
                  ? AppThemePalette.of(context).accentDeep
                  : AppThemePalette.of(context).inkFaint,
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Text(
                entry.name,
                style: AppTypography.mono(
                  fontSize: 11,
                  color: AppThemePalette.of(context).inkMuted,
                ),
              ),
            ),
            Text(
              entry.isDirectory ? 'DIR' : 'FILE',
              style: AppTypography.mono(
                fontSize: 9,
                color: AppThemePalette.of(context).inkFaint,
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
  const _MarkdownDocument({required this.source, required this.onTapLink});

  final String source;
  final ValueChanged<String> onTapLink;

  @override
  Widget build(BuildContext context) {
    return AppMarkdown(
      data: source,
      textStyle: AppTypography.body(
        fontSize: 13,
        color: AppThemePalette.of(context).ink,
        height: 1.5,
      ),
      onTapLink: onTapLink,
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
            color: AppThemePalette.of(context).inkFaint,
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
              style: AppTypography.body(
                fontSize: 13,
                color: AppThemePalette.of(context).ink,
              ),
              decoration: InputDecoration(
                filled: true,
                fillColor: AppThemePalette.of(context).surface,
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 11,
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: BorderSide(
                    color: AppThemePalette.of(context).surfaceActive,
                  ),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(6),
                  borderSide: BorderSide(
                    color: AppThemePalette.of(context).accent,
                  ),
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
          ? AppThemePalette.of(context).danger.withValues(alpha: 0.06)
          : AppThemePalette.of(context).surfaceRaised,
      child: Row(
        children: [
          Expanded(
            child: Text(
              error ? '⚠ $message' : message,
              style: AppTypography.mono(
                fontSize: 10,
                color: error
                    ? AppThemePalette.of(context).danger
                    : AppThemePalette.of(context).inkFaint,
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
            Icon(icon, size: 30, color: AppThemePalette.of(context).inkFaint),
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
                color: AppThemePalette.of(context).inkFaint,
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
    return Center(
      child: SizedBox.square(
        dimension: 22,
        child: CircularProgressIndicator(
          strokeWidth: 1.7,
          color: AppThemePalette.of(context).accentStrong,
        ),
      ),
    );
  }
}

class _DocumentationSkeleton extends StatelessWidget {
  const _DocumentationSkeleton();

  @override
  Widget build(BuildContext context) {
    return const Column(
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
    );
  }
}

class _Skeleton extends StatelessWidget {
  const _Skeleton({required this.width, required this.height});

  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      width: width,
      height: height,
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
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
  ProjectDetailTab.overview => 'Documents',
  ProjectDetailTab.sessions => 'Sessions',
  ProjectDetailTab.files => 'Files',
  ProjectDetailTab.settings => 'Settings',
};
