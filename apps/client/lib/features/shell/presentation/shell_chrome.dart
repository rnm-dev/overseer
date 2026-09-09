import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/ui_kit.dart';
import '../../auth/domain/auth_models.dart';

/// The composition root supplies the additional Windows navigation.
final fleetSidebarBuilderProvider = Provider<WidgetBuilder?>((ref) => null);

/// Desktop/tablet navigation chrome. Fleet content and its callbacks stay in
/// FleetOverview; this widget owns only shell-level navigation.
class ShellConnectionRail extends ConsumerWidget {
  const ShellConnectionRail({
    super.key,
    required this.overseerName,
    required this.user,
    this.onBackToConnections,
    this.width = 224,
    this.onOverview,
    this.overviewSelected = true,
  });

  final String? overseerName;
  final OperatorIdentity? user;
  final VoidCallback? onBackToConnections;
  final double width;
  final VoidCallback? onOverview;
  final bool overviewSelected;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).colorScheme;
    final name = overseerName?.trim().isNotEmpty == true
        ? overseerName!.trim()
        : 'Overseer';

    final sidebarBuilder = ref.watch(fleetSidebarBuilderProvider);
    final navigation = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              Icon(LucideIcons.radioTower, size: 18, color: colors.primary),
              const SizedBox(width: 9),
              Text(
                'OVERSEER',
                style: AppTypography.sectionLabel(color: colors.onSurface),
              ),
            ],
          ),
        ),
        const SizedBox(height: 26),
        AppCard(
          variant: SurfaceVariant.inset,
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  name,
                  key: const Key('shell-overseer-name'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.body(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: colors.onSurface,
                  ),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 22),
        AppSectionHeader(
          title: 'Workspace',
          padding: const EdgeInsets.symmetric(horizontal: 4),
        ),
        const SizedBox(height: 8),
        AppListTile(
          key: const Key('shell-overview-navigation'),
          title: 'Fleet overview',
          leading: Icon(LucideIcons.layoutDashboard, color: colors.primary),
          selected: overviewSelected,
          onTap: onOverview,
          density: AppListTileDensity.compact,
          semanticsHint: 'Shows your workspaces and Peons',
        ),
        const SizedBox(height: 24),
      ],
    );
    final footer = Column(
      key: const Key('shell-account-footer'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (user != null) ...[
          AppCard(
            variant: SurfaceVariant.subtle,
            padding: const EdgeInsets.all(10),
            child: Row(
              children: [
                UserAvatar(
                  label: user!.email,
                  src: user!.avatarUrl,
                  size: UserAvatarSize.sm,
                ),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    user!.email,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.body(
                      fontSize: 11.5,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
        ],
        if (onBackToConnections != null)
          AppButton(
            key: const Key('shell-back-to-connections'),
            onPressed: onBackToConnections,
            variant: AppButtonVariant.ghost,
            size: AppButtonSize.sm,
            fullWidth: true,
            tooltip: 'Back to Overseer list',
            leading: const Icon(LucideIcons.arrowLeft, size: 16),
            child: const Text('Back'),
          ),
      ],
    );
    return SizedBox(
      width: width,
      height: double.infinity,
      child: sidebarBuilder != null
          ? Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 18, 14, 0),
                  child: navigation,
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 14),
                    child: user != null
                        ? sidebarBuilder(context)
                        : const SizedBox.shrink(),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
                  child: footer,
                ),
              ],
            )
          : SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(14, 18, 14, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [navigation, footer],
              ),
            ),
    );
  }
}

class ShellDesktopHeader extends StatelessWidget {
  const ShellDesktopHeader({super.key, required this.overseerName});

  final String? overseerName;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final name = overseerName?.trim().isNotEmpty == true
        ? overseerName!.trim()
        : 'Overseer';

    return SizedBox(
      height: 76,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Row(
          children: [
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Fleet overview', style: AppTypography.pageTitle()),
                  const SizedBox(height: 3),
                  Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.metadata(
                      color: colors.onSurfaceVariant,
                    ),
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
