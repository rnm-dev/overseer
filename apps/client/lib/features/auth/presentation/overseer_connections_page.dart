import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/presentation/add_overseer_panel.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/layout/responsive_breakpoints.dart';
import 'package:overseer_mobile/shared/widgets/app_bottom_sheet.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_page_header.dart';
import 'package:overseer_mobile/shared/widgets/confirmation_bottom_sheet.dart';
import 'package:overseer_mobile/shared/widgets/entity_list_tile.dart';
import 'package:overseer_mobile/shared/widgets/app_option_bottom_sheet.dart';
import 'package:overseer_mobile/shared/widgets/loading_shimmer.dart';

class OverseerConnectionsLoadingPage extends StatelessWidget {
  const OverseerConnectionsLoadingPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      key: const Key('overseer-connections-loading'),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: context.appSpacing.screenInsets(top: 20, bottom: 20),
              child: const LoadingShimmer(
                label: 'Loading Overseer connections',
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    ShimmerBlock(width: double.infinity, height: 28),
                    SizedBox(height: 12),
                    ShimmerBlock(width: 220, height: 14),
                    SizedBox(height: 24),
                    ShimmerBlock(
                      width: double.infinity,
                      height: 56,
                      borderRadius: BorderRadius.all(Radius.circular(12)),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class OverseerConnectionsPage extends StatelessWidget {
  const OverseerConnectionsPage({
    super.key,
    required this.connections,
    required this.onAdd,
    required this.onSelect,
    required this.onDelete,
    this.initialUrl = '',
  });

  final List<OverseerConnection> connections;
  final Future<void> Function(Uri serverUrl) onAdd;
  final ValueChanged<OverseerConnection> onSelect;
  final Future<void> Function(OverseerConnection connection) onDelete;
  final String initialUrl;

  bool get _isEmpty => connections.isEmpty;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  const verticalPadding = 40.0;
                  return SingleChildScrollView(
                    key: const Key('overseer-connections-content'),
                    padding: context.appSpacing.screenInsets(
                      top: 20,
                      bottom: 20,
                    ),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        minHeight: (constraints.maxHeight - verticalPadding)
                            .clamp(0, double.infinity),
                      ),
                      child: Center(
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 520),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              AppPageHeader(
                                title: 'Overseer connections',
                                subtitle: _isEmpty
                                    ? 'Add an Overseer server to get started.'
                                    : 'Choose an Overseer to continue.',
                              ),
                              const SizedBox(height: 24),
                              if (_isEmpty)
                                _EmptyConnections(
                                  onAdd: () => _showAddOverseer(context),
                                )
                              else
                                Column(
                                  key: const Key('overseer-connections-list'),
                                  children: [
                                    for (
                                      var index = 0;
                                      index < connections.length;
                                      index++
                                    ) ...[
                                      if (index > 0) const SizedBox(height: 8),
                                      _ConnectionTile(
                                        connection: connections[index],
                                        onSelect: onSelect,
                                        onLongPress: (rowContext) =>
                                            _showConnectionActions(
                                              rowContext,
                                              connections[index],
                                            ),
                                      ),
                                    ],
                                  ],
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ),
            if (!_isEmpty)
              Padding(
                padding: context.appSpacing.screenInsets(bottom: 20),
                child: AppButton(
                  key: const Key('add-overseer-button'),
                  onPressed: () => _showAddOverseer(context),
                  fullWidth: true,
                  size: AppButtonSize.lg,
                  variant: AppButtonVariant.secondary,
                  leading: const Icon(LucideIcons.plus, size: 18),
                  child: const Text('Add Overseer'),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _showAddOverseer(BuildContext context) {
    return showAppBottomSheet<void>(
      context: context,
      builder: (sheetContext) => AddOverseerPanel(
        initialUrl: initialUrl,
        onContinue: (serverUrl) async {
          await onAdd(serverUrl);
          if (sheetContext.mounted) Navigator.of(sheetContext).pop();
        },
      ),
    );
  }

  Future<void> _showConnectionActions(
    BuildContext context,
    OverseerConnection connection,
  ) async {
    final layoutSize = ResponsiveBreakpoints.sizeFor(
      MediaQuery.sizeOf(context).width,
    );
    final action = layoutSize == ResponsiveLayoutSize.wide
        ? await _showWideConnectionMenu(context)
        : await showAppOptionBottomSheet<_ConnectionMenuAction>(
            context: context,
            builder: (context) => const _ConnectionActionsBottomSheet(),
          );
    if (action != _ConnectionMenuAction.delete || !context.mounted) return;

    final confirmed = await showAppConfirmationBottomSheet(
      context: context,
      title: 'Delete Overseer?',
      message:
          'Remove ${connection.title} and its saved login from this device?',
      confirmLabel: 'Delete Overseer',
      destructive: true,
    );
    if (!confirmed || !context.mounted) return;

    try {
      await onDelete(connection);
    } catch (_) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text('The Overseer could not be deleted. Please try again.'),
        ),
      );
    }
  }

  Future<_ConnectionMenuAction?> _showWideConnectionMenu(BuildContext context) {
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final row = context.findRenderObject()! as RenderBox;
    final anchor = row.localToGlobal(
      Offset(row.size.width - 12, row.size.height / 2),
      ancestor: overlay,
    );
    final x = anchor.dx.clamp(8.0, overlay.size.width - 8).toDouble();
    final y = anchor.dy.clamp(8.0, overlay.size.height - 8).toDouble();

    return showMenu<_ConnectionMenuAction>(
      context: context,
      useRootNavigator: true,
      color: AppColors.iron950,
      surfaceTintColor: Colors.transparent,
      elevation: 12,
      constraints: const BoxConstraints.tightFor(width: 160),
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.all(Radius.circular(8)),
        side: BorderSide(color: AppColors.iron800),
      ),
      position: RelativeRect.fromLTRB(
        x,
        y,
        overlay.size.width - x,
        overlay.size.height - y,
      ),
      items: [
        PopupMenuItem<_ConnectionMenuAction>(
          key: const Key('overseer-menu-delete'),
          value: _ConnectionMenuAction.delete,
          height: 40,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Row(
            children: [
              const Icon(LucideIcons.trash2, size: 13, color: AppColors.blood),
              const SizedBox(width: 8),
              Text(
                'Delete',
                style: AppTypography.body(fontSize: 12, color: AppColors.blood),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

enum _ConnectionMenuAction { delete }

class _ConnectionTile extends StatelessWidget {
  const _ConnectionTile({
    required this.connection,
    required this.onSelect,
    required this.onLongPress,
  });

  final OverseerConnection connection;
  final ValueChanged<OverseerConnection> onSelect;
  final Future<void> Function(BuildContext context) onLongPress;

  @override
  Widget build(BuildContext context) {
    return EntityListTile(
      key: ValueKey('overseer-connection-${connection.id}'),
      title: connection.title,
      subtitle: connection.serverUrl.toString(),
      semanticsHint: 'Open this Overseer. Long press for actions.',
      leading: const Icon(LucideIcons.server, size: 20, color: AppColors.fel),
      onTap: () => onSelect(connection),
      onLongPress: () => onLongPress(context),
    );
  }
}

class _ConnectionActionsBottomSheet extends StatelessWidget {
  const _ConnectionActionsBottomSheet();

  @override
  Widget build(BuildContext context) {
    return AppOptionBottomSheet(
      title: 'Overseer actions',
      handleKey: const Key('overseer-menu-sheet-handle'),
      children: [
        AppOptionSheetTile(
          key: const Key('overseer-menu-delete'),
          onTap: () => Navigator.of(context).pop(_ConnectionMenuAction.delete),
          child: Row(
            children: [
              const Icon(LucideIcons.trash2, size: 20, color: AppColors.blood),
              const SizedBox(width: 12),
              Text(
                'Delete',
                style: AppTypography.optionLabel(
                  selected: false,
                ).copyWith(color: AppColors.blood),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _EmptyConnections extends StatelessWidget {
  const _EmptyConnections({required this.onAdd});

  final VoidCallback onAdd;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 360),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text('No connections yet', style: AppTypography.sectionTitle()),
            const SizedBox(height: 6),
            Text(
              'Your saved Overseer servers will appear here.',
              textAlign: TextAlign.center,
              style: AppTypography.body(fontSize: 13, color: AppColors.boneDim),
            ),
            const SizedBox(height: 20),
            AppButton(
              key: const Key('empty-add-overseer-button'),
              onPressed: onAdd,
              size: AppButtonSize.lg,
              leading: const Icon(LucideIcons.plus, size: 18),
              child: const Text('Add Overseer'),
            ),
          ],
        ),
      ),
    );
  }
}
