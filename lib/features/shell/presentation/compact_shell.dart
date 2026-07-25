import 'package:flutter/material.dart';

import '../../auth/domain/auth_models.dart';
import '../../fleet/fleet.dart';

class CompactShell extends StatelessWidget {
  const CompactShell({super.key, required this.user, required this.onSignOut});

  final OperatorIdentity user;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('compact-shell'),
      body: SafeArea(
        child: FleetOverview(compact: true, user: user, onSignOut: onSignOut),
      ),
    );
  }
}
