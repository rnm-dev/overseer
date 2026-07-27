import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/models/ai_capabilities.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_card.dart';
import '../../../shared/widgets/app_option_bottom_sheet.dart';
import '../../../shared/widgets/app_text_field.dart';
import '../../../shared/widgets/confirmation_bottom_sheet.dart';
import '../../fleet/application/fleet_controller.dart';
import '../../fleet/domain/fleet_models.dart';
import '../application/peon_settings_controller.dart';
import '../application/peon_management_controller.dart';
import '../domain/peon_management_models.dart';
import '../domain/peon_management_repository.dart';
import '../domain/peon_settings_models.dart';
part 'peon_settings_sections.dart';

enum _SettingsSection { general, agent, armory }

class PeonSettingsPage extends ConsumerStatefulWidget {
  const PeonSettingsPage({
    super.key,
    required this.workspace,
    required this.peon,
  });

  final Workspace workspace;
  final Peon peon;

  @override
  ConsumerState<PeonSettingsPage> createState() => _PeonSettingsPageState();
}

class _PeonSettingsPageState extends ConsumerState<PeonSettingsPage> {
  _SettingsSection _section = _SettingsSection.general;

  PeonSettingsScope get _scope => PeonSettingsScope(
    workspaceId: widget.workspace.id,
    peonId: widget.peon.id,
    online: widget.peon.online,
  );

  @override
  Widget build(BuildContext context) {
    if (widget.workspace.role != null && widget.workspace.role != 'owner') {
      return const _Notice(
        icon: LucideIcons.lock,
        title: 'Owner access required',
        message: 'Peon management settings are available to workspace owners.',
      );
    }
    final settings = ref.watch(peonSettingsControllerProvider(_scope));
    return Column(
      key: const Key('peon-settings-page'),
      children: [
        _SectionTabs(
          selected: _section,
          onSelected: (section) => setState(() => _section = section),
        ),
        Expanded(
          child: settings.when(
            data: (state) {
              final value = state.settings;
              return switch (_section) {
                _SettingsSection.general => _GeneralSettings(
                  scope: _scope,
                  peon: widget.peon,
                  settings: value ?? const PeonSettings(),
                  state: state,
                  onDeleted: () {
                    ref.invalidate(fleetControllerProvider);
                    Navigator.of(context).pop();
                  },
                  onRetry: () =>
                      ref.invalidate(peonSettingsControllerProvider(_scope)),
                ),
                _SettingsSection.agent =>
                  value == null
                      ? _Notice(
                          icon: state.unsupported
                              ? LucideIcons.triangleAlert
                              : LucideIcons.cloudOff,
                          title: state.unsupported
                              ? 'Settings unavailable'
                              : 'Agent settings unavailable',
                          message:
                              state.loadMessage ??
                              (widget.peon.online
                                  ? 'Could not load remote Agent settings.'
                                  : 'Agent settings are available when the Peon '
                                        'reconnects.'),
                          action: widget.peon.online
                              ? AppButton(
                                  onPressed: () => ref.invalidate(
                                    peonSettingsControllerProvider(_scope),
                                  ),
                                  child: const Text('Retry'),
                                )
                              : null,
                        )
                      : _AgentSettings(
                          scope: _scope,
                          settings: value,
                          state: state,
                        ),
                _SettingsSection.armory => _ArmorySettings(
                  scope: _scope,
                  peon: widget.peon,
                ),
              };
            },
            loading: () => const Center(
              child: CircularProgressIndicator(
                strokeWidth: 1.7,
                color: AppColors.felBright,
              ),
            ),
            error: (error, _) => _Notice(
              icon: LucideIcons.cloudOff,
              title: 'Could not load settings',
              message: error.toString(),
              action: AppButton(
                onPressed: () =>
                    ref.invalidate(peonSettingsControllerProvider(_scope)),
                child: const Text('Retry'),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  @override
  Widget build(BuildContext context) => Center(
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
          if (action != null) ...[const SizedBox(height: 16), action!],
        ],
      ),
    ),
  );
}
