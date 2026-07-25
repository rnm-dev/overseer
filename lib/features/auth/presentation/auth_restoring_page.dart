import 'package:flutter/widgets.dart';
import 'package:overseer_mobile/shared/widgets/app_restoring_page.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

/// Auth-owned name for the shared branded restoration surface.
class AuthRestoringPage extends StatelessWidget {
  const AuthRestoringPage({super.key});

  static const double logoExtent = OverseerLogo.splashExtent;
  static const double progressOffset = AppRestoringPage.progressOffset;

  @override
  Widget build(BuildContext context) => const AppRestoringPage();
}
