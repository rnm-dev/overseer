import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/spacing.dart';
import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';

class WideShell extends StatelessWidget {
  const WideShell({super.key, required this.user, required this.onSignOut});

  final OperatorIdentity? user;
  final Future<void> Function()? onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('wide-shell'),
      body: SafeArea(
        child: Row(
          children: [
            const SizedBox(
              key: Key('wide-sidebar'),
              width: 280,
              child: _WideSidebar(),
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const _WideHeader(),
                  const Divider(height: 1),
                  Expanded(
                    child: Row(
                      children: [
                        SizedBox(
                          key: const Key('wide-master-pane'),
                          width: 320,
                          child: ColoredBox(
                            color: Theme.of(
                              context,
                            ).colorScheme.surfaceContainerHighest,
                            child: user == null
                                ? const FleetOverviewLoading()
                                : FleetOverview(
                                    user: user!,
                                    onSignOut: onSignOut!,
                                  ),
                          ),
                        ),
                        const VerticalDivider(width: 1),
                        const Expanded(
                          key: Key('wide-detail-pane'),
                          child: _WideDetailPlaceholder(),
                        ),
                      ],
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

class _WideDetailPlaceholder extends StatelessWidget {
  const _WideDetailPlaceholder();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Text(
        'Select a peon to view its sessions',
        style: TextStyle(color: AppColors.boneDim),
      ),
    );
  }
}

class _WideSidebar extends StatelessWidget {
  const _WideSidebar();

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: context.appSpacing.screenInsets(top: 20, bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            'Overseer Mobile',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: 24),
          const ListTile(
            selected: true,
            leading: Icon(LucideIcons.layoutDashboard),
            title: Text('Overview'),
          ),
          const ListTile(
            leading: Icon(LucideIcons.settings),
            title: Text('Settings'),
          ),
        ],
      ),
    );
  }
}

class _WideHeader extends StatelessWidget {
  const _WideHeader();

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
            'Overview',
            style: Theme.of(context).textTheme.titleLarge,
          ),
        ),
      ),
    );
  }
}
