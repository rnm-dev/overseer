import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/entity_list_tile.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

class OverseerConnectionsPage extends StatelessWidget {
  const OverseerConnectionsPage({
    super.key,
    required this.connections,
    required this.onAdd,
    required this.onSelect,
    this.logo = const OverseerLogo(size: 220),
  });

  final List<OverseerConnection> connections;
  final VoidCallback onAdd;
  final ValueChanged<OverseerConnection> onSelect;
  final Widget logo;

  bool get _isEmpty => connections.isEmpty;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          const Image(
            key: Key('connections-hero'),
            image: AssetImage('assets/images/sign-in-hero.png'),
            fit: BoxFit.cover,
            filterQuality: FilterQuality.high,
            excludeFromSemantics: true,
          ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[
                  Color(0x33060806),
                  Color(0xB3060806),
                  AppColors.voidColor,
                ],
                stops: <double>[0, 0.42, 1],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: context.appSpacing.screenInsets(top: 20, bottom: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Center(child: logo),
                  const SizedBox(height: 16),
                  Text(
                    'Overseer connections',
                    textAlign: TextAlign.center,
                    style: AppTypography.display(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: AppColors.bone,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    _isEmpty
                        ? 'Add an Overseer server to get started.'
                        : 'Choose an Overseer to continue.',
                    textAlign: TextAlign.center,
                    style: AppTypography.body(
                      fontSize: 14,
                      color: AppColors.boneDim,
                    ),
                  ),
                  const SizedBox(height: 24),
                  Expanded(
                    child: _isEmpty
                        ? _EmptyConnections(onAdd: onAdd)
                        : ListView.separated(
                            key: const Key('overseer-connections-list'),
                            itemCount: connections.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(height: 8),
                            itemBuilder: (context, index) {
                              final connection = connections[index];
                              return EntityListTile(
                                key: ValueKey(
                                  'overseer-connection-${connection.id}',
                                ),
                                title: connection.title,
                                subtitle: connection.serverUrl.toString(),
                                semanticsHint: 'Open this Overseer',
                                leading: const Icon(
                                  LucideIcons.server,
                                  size: 20,
                                  color: AppColors.fel,
                                ),
                                trailing: const Icon(
                                  LucideIcons.chevronRight,
                                  size: 18,
                                  color: AppColors.boneDim,
                                ),
                                onTap: () => onSelect(connection),
                              );
                            },
                          ),
                  ),
                  if (!_isEmpty) ...<Widget>[
                    const SizedBox(height: 16),
                    AppButton(
                      key: const Key('add-overseer-button'),
                      onPressed: onAdd,
                      fullWidth: true,
                      size: AppButtonSize.lg,
                      variant: AppButtonVariant.secondary,
                      leading: const Icon(LucideIcons.plus, size: 18),
                      child: const Text('Add Overseer'),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
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
            const Icon(
              LucideIcons.serverCog,
              size: 42,
              color: AppColors.boneDim,
            ),
            const SizedBox(height: 16),
            Text(
              'No connections yet',
              style: AppTypography.body(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: AppColors.bone,
              ),
            ),
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
