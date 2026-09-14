import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/config/overseer_connection_store.dart';
import '../../../shared/ui_kit.dart';

/// Windows composition supplies the saved connections and existing switch flow.
final overseerSwitcherProvider = Provider<OverseerSwitcherData?>((ref) => null);

class OverseerSwitcherData {
  const OverseerSwitcherData({
    required this.connections,
    required this.current,
    required this.onSelect,
    required this.onManage,
  });
  final List<OverseerConnection> connections;
  final OverseerConnection current;
  final ValueChanged<OverseerConnection> onSelect;
  final VoidCallback onManage;
}

class OverseerSwitcher extends StatelessWidget {
  const OverseerSwitcher({super.key, required this.data, this.plain = false});
  final OverseerSwitcherData data;
  final bool plain;

  Widget _surface({required Widget child}) => plain
      ? Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14),
          child: child,
        )
      : AppCard(
          variant: SurfaceVariant.inset,
          padding: const EdgeInsets.all(12),
          child: child,
        );

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return PopupMenuButton<String>(
      key: const Key('overseer-switcher'),
      tooltip: 'Switch Overseer',
      position: PopupMenuPosition.under,
      color: colors.surfaceContainerHighest,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: colors.outlineVariant),
      ),
      constraints: const BoxConstraints(minWidth: 260, maxWidth: 340),
      onSelected: (id) {
        if (id == 'manage') {
          data.onManage();
          return;
        }
        if (id == data.current.id) return;
        final connection = data.connections
            .where((item) => item.id == id)
            .firstOrNull;
        if (connection != null) data.onSelect(connection);
      },
      itemBuilder: (_) => [
        for (final connection in data.connections)
          PopupMenuItem(
            value: connection.id,
            child: Row(
              children: [
                Icon(
                  connection.id == data.current.id
                      ? LucideIcons.check
                      : LucideIcons.server,
                  size: 16,
                  color: connection.id == data.current.id
                      ? colors.primary
                      : colors.onSurfaceVariant,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        connection.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.body(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                          color: connection.id == data.current.id
                              ? colors.primary
                              : colors.onSurface,
                        ),
                      ),
                      Text(
                        connection.id,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.body(
                          fontSize: 11,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        const PopupMenuDivider(),
        const PopupMenuItem(
          value: 'manage',
          child: Row(
            children: [
              Icon(LucideIcons.plus, size: 16),
              SizedBox(width: 10),
              Expanded(child: Text('Add or manage Overseers')),
            ],
          ),
        ),
      ],
      child: _surface(
        child: Row(
          children: [
            Expanded(
              child: Text(
                data.current.title,
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
            const SizedBox(width: 8),
            Icon(LucideIcons.chevronDown, size: 16, color: colors.primary),
          ],
        ),
      ),
    );
  }
}
