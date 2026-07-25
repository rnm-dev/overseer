import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../auth/domain/auth_models.dart';
import '../../fleet/application/fleet_controller.dart';
import '../../../shared/layout/responsive_breakpoints.dart';
import '../../../shared/widgets/app_restoring_page.dart';
import 'compact_shell.dart';
import 'medium_shell.dart';
import 'wide_shell.dart';

class ShellPage extends ConsumerWidget {
  const ShellPage({super.key, required this.user, required this.onSignOut});

  final OperatorIdentity user;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final fleet = ref.watch(fleetControllerProvider);
    if (fleet.isLoading && !fleet.hasValue) {
      return const AppRestoringPage();
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        return switch (ResponsiveBreakpoints.sizeFor(constraints.maxWidth)) {
          ResponsiveLayoutSize.compact => CompactShell(
            user: user,
            onSignOut: onSignOut,
          ),
          ResponsiveLayoutSize.medium => MediumShell(
            user: user,
            onSignOut: onSignOut,
          ),
          ResponsiveLayoutSize.wide => WideShell(
            user: user,
            onSignOut: onSignOut,
          ),
        };
      },
    );
  }
}
