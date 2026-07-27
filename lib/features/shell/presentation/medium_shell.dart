import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/spacing.dart';
import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';

class MediumShell extends StatelessWidget {
  const MediumShell({
    super.key,
    required this.user,
    required this.onSignOut,
    this.onOpenPeon,
  });

  final OperatorIdentity? user;
  final Future<void> Function()? onSignOut;
  final void Function(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
  })?
  onOpenPeon;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('medium-shell'),
      body: SafeArea(
        child: Row(
          children: [
            NavigationRail(
              key: const Key('medium-navigation-rail'),
              selectedIndex: 0,
              labelType: NavigationRailLabelType.all,
              destinations: const [
                NavigationRailDestination(
                  icon: Icon(LucideIcons.layoutDashboard),
                  selectedIcon: Icon(LucideIcons.layoutDashboard),
                  label: Text('Overview'),
                ),
                NavigationRailDestination(
                  icon: Icon(LucideIcons.settings),
                  selectedIcon: Icon(LucideIcons.settings),
                  label: Text('Settings'),
                ),
              ],
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const _MediumHeader(),
                  Expanded(
                    child: user == null
                        ? const FleetOverviewLoading()
                        : FleetOverview(
                            user: user!,
                            onSignOut: onSignOut!,
                            onOpenPeon: onOpenPeon,
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

class _MediumHeader extends StatelessWidget {
  const _MediumHeader();

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: kToolbarHeight,
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: context.appSpacing.screenHorizontal,
        ),
        child: Align(
          alignment: Alignment.centerLeft,
          child: Text(
            'Overseer Mobile',
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ),
      ),
    );
  }
}
