import 'package:flutter/material.dart';

import '../../auth/domain/auth_models.dart';
import '../../../shared/layout/responsive_breakpoints.dart';
import 'compact_shell.dart';
import 'medium_shell.dart';
import 'wide_shell.dart';

class ShellPage extends StatelessWidget {
  const ShellPage({
    super.key,
    required this.user,
    required this.onSignOut,
    this.onOpenPeon,
    this.overseerName,
    this.onBackToConnections,
  }) : assert(user != null),
       assert(onSignOut != null);

  const ShellPage.loading({
    super.key,
    this.overseerName,
    this.onBackToConnections,
  }) : user = null,
       onSignOut = null,
       onOpenPeon = null;

  final OperatorIdentity? user;
  final Future<void> Function()? onSignOut;
  final void Function(
    BuildContext context, {
    required String workspaceId,
    required String peonId,
  })?
  onOpenPeon;
  final String? overseerName;
  final VoidCallback? onBackToConnections;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return switch (ResponsiveBreakpoints.sizeFor(constraints.maxWidth)) {
          ResponsiveLayoutSize.compact => CompactShell(
            user: user,
            onSignOut: onSignOut,
            onOpenPeon: onOpenPeon,
            overseerName: overseerName,
            onBackToConnections: onBackToConnections,
          ),
          ResponsiveLayoutSize.medium => MediumShell(
            user: user,
            onSignOut: onSignOut,
            onOpenPeon: onOpenPeon,
          ),
          ResponsiveLayoutSize.wide => WideShell(
            user: user,
            onSignOut: onSignOut,
            onOpenPeon: onOpenPeon,
          ),
        };
      },
    );
  }
}
