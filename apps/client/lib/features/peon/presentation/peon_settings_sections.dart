part of 'peon_settings_page.dart';

class _SectionTabs extends StatelessWidget {
  const _SectionTabs({required this.selected, required this.onSelected});

  final _SettingsSection selected;
  final ValueChanged<_SettingsSection> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      height: 48,
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.outlineVariant)),
      ),
      child: Row(
        children: [
          for (final section in _SettingsSection.values)
            Expanded(
              child: InkWell(
                key: Key('peon-settings-${section.name}'),
                onTap: () => onSelected(section),
                child: Container(
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    border: Border(
                      bottom: BorderSide(
                        width: 2,
                        color: selected == section
                            ? colors.primary
                            : Colors.transparent,
                      ),
                    ),
                  ),
                  child: Text(
                    switch (section) {
                      _SettingsSection.general => 'General',
                      _SettingsSection.agent => 'Agent',
                      _SettingsSection.armory => 'Armory',
                    },
                    style: AppTypography.display(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: selected == section
                          ? colors.primary
                          : colors.onSurfaceVariant,
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _GeneralSettings extends ConsumerStatefulWidget {
  const _GeneralSettings({
    required this.scope,
    required this.peon,
    required this.settings,
    required this.state,
    required this.onDeleted,
    required this.onRetry,
  });

  final PeonSettingsScope scope;
  final Peon peon;
  final PeonSettings settings;
  final PeonSettingsState state;
  final VoidCallback onDeleted;
  final VoidCallback onRetry;

  @override
  ConsumerState<_GeneralSettings> createState() => _GeneralSettingsState();
}

class _GeneralSettingsState extends ConsumerState<_GeneralSettings> {
  late final TextEditingController _address;
  late final TextEditingController _name;
  late final TextEditingController _fileRoot;
  late final TextEditingController _heartbeat;
  String? _nameError;
  String? _heartbeatError;

  @override
  void initState() {
    super.initState();
    _address = TextEditingController(text: widget.peon.baseUrl ?? '');
    _name = TextEditingController(text: widget.settings.name ?? '');
    _fileRoot = TextEditingController(
      text: widget.settings.fileTransferRoot ?? '',
    );
    _heartbeat = TextEditingController(
      text: widget.settings.heartbeatIntervalMs?.toString() ?? '',
    );
  }

  @override
  void dispose() {
    _address.dispose();
    _name.dispose();
    _fileRoot.dispose();
    _heartbeat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.read(
      peonSettingsControllerProvider(widget.scope).notifier,
    );
    return ListView(
      key: const Key('peon-settings-general-pane'),
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 32),
      children: [
        if (widget.state.status case final status?)
          _SettingsCard(
            title: 'Peon update',
            subtitle: status.updateAvailable
                ? 'A newer Peon revision is available.'
                : 'This Peon is up to date.',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (widget.state.updatePhase == PeonUpdatePhase.installing ||
                    widget.state.updatePhase == PeonUpdatePhase.restarting)
                  _InlineStatus(
                    text: widget.state.updatePhase == PeonUpdatePhase.installing
                        ? 'Installing the update…'
                        : 'Waiting for the Peon to restart…',
                  ),
                if (widget.state.updatePhase == PeonUpdatePhase.complete)
                  const _InlineStatus(text: '⚡ Update complete'),
                if (status.updateLocalSha case final value?)
                  _Detail(label: 'LOCAL', value: value),
                if (status.updateRemoteSha case final value?)
                  _Detail(label: 'REMOTE', value: value),
                if (status.updateCheckError case final value?)
                  _ErrorText(value),
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: AppButton(
                    key: const Key('peon-update-action'),
                    loading:
                        widget.state.checkingUpdate ||
                        widget.state.updatePhase == PeonUpdatePhase.installing,
                    disabled:
                        widget.state.updatePhase == PeonUpdatePhase.restarting,
                    onPressed: status.updateAvailable
                        ? controller.installUpdate
                        : controller.checkForUpdate,
                    child: Text(
                      status.updateAvailable ? 'Install update' : 'Check now',
                    ),
                  ),
                ),
              ],
            ),
          ),
        if (widget.state.status != null) const SizedBox(height: 12),
        _SettingsCard(
          title: 'Connection',
          subtitle:
              'How Overseer reaches this Peon. You can fix it while offline.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppTextField(
                key: const Key('peon-address-field'),
                controller: _address,
                label: 'ADDRESS',
                hint: 'http://peon.example:4570',
                mono: true,
                keyboardType: TextInputType.url,
                onChanged: (_) => setState(() {}),
              ),
              if (widget.peon.addressSource case final source?)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    'Source: $source',
                    style: AppTypography.mono(
                      fontSize: 10.5,
                      color: AppThemePalette.of(context).inkFaint,
                    ),
                  ),
                ),
              const SizedBox(height: 14),
              _SaveRow(
                loading: widget.state.connectionSaving,
                saved: widget.state.connectionSaved,
                onPressed: _address.text.trim().isEmpty
                    ? null
                    : () async {
                        final saved = await controller.saveConnection(
                          _address.text.trim(),
                        );
                        if (saved) ref.invalidate(fleetControllerProvider);
                      },
              ),
            ],
          ),
        ),
        if (widget.peon.online && widget.state.settings == null) ...[
          const SizedBox(height: 12),
          _SettingsCard(
            title: widget.state.unsupported
                ? 'Remote settings unavailable'
                : 'Could not load remote settings',
            subtitle:
                widget.state.loadMessage ??
                'The connection and removal controls remain available.',
            child: Align(
              alignment: Alignment.centerRight,
              child: AppButton(
                key: const Key('peon-settings-retry'),
                onPressed: widget.onRetry,
                child: const Text('Retry'),
              ),
            ),
          ),
        ],
        if (widget.peon.online) const SizedBox(height: 12),
        if (widget.peon.online && widget.state.settings != null)
          _SettingsCard(
            title: 'General settings',
            subtitle: 'Identity, file transfer sandbox, and heartbeat cadence.',
            child: Column(
              children: [
                AppTextField(
                  key: const Key('peon-name-field'),
                  controller: _name,
                  label: 'NAME',
                  errorText: _nameError,
                  onChanged: (_) {
                    if (_nameError != null) {
                      setState(() => _nameError = null);
                    }
                  },
                ),
                const SizedBox(height: 14),
                AppTextField(
                  key: const Key('peon-file-root-field'),
                  controller: _fileRoot,
                  label: 'FILE TRANSFER ROOT',
                  hint: '/srv/peon/files',
                  mono: true,
                ),
                const SizedBox(height: 14),
                AppTextField(
                  key: const Key('peon-heartbeat-field'),
                  controller: _heartbeat,
                  label: 'HEARTBEAT INTERVAL (MS)',
                  hint: '5000',
                  mono: true,
                  keyboardType: TextInputType.number,
                  errorText: _heartbeatError,
                  onChanged: (_) {
                    if (_heartbeatError != null) {
                      setState(() => _heartbeatError = null);
                    }
                  },
                ),
                const SizedBox(height: 14),
                _SaveRow(
                  loading: widget.state.saving,
                  saved: widget.state.saved,
                  onPressed: () => _saveGeneral(controller),
                ),
              ],
            ),
          ),
        if (widget.state.message case final message?) ...[
          const SizedBox(height: 12),
          _ErrorText(message),
        ],
        const SizedBox(height: 26),
        Text(
          'DANGER ZONE',
          style: AppTypography.display(
            fontSize: 10,
            letterSpacing: 1.8,
            fontWeight: FontWeight.w700,
            color: AppThemePalette.of(context).danger,
          ),
        ),
        const SizedBox(height: 8),
        _SettingsCard(
          title: 'Kick Peon',
          subtitle:
              'Disconnect it from the workspace and revoke its access. '
              'The daemon and local data remain.',
          child: Align(
            alignment: Alignment.centerRight,
            child: AppButton(
              key: const Key('peon-kick-action'),
              variant: AppButtonVariant.danger,
              loading: widget.state.deleting,
              onPressed: () async {
                final confirmed = await showAppConfirmationBottomSheet(
                  context: context,
                  title: 'Kick ${widget.peon.displayName}?',
                  message:
                      'This revokes the Peon access and disconnects it from '
                      'the workspace. Active work will not be stopped. '
                      'This cannot be undone.',
                  confirmLabel: 'Kick Peon',
                  destructive: true,
                );
                if (!confirmed) return;
                if (await controller.deletePeon()) widget.onDeleted();
              },
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(LucideIcons.sportShoe, size: 16),
                  SizedBox(width: 7),
                  Text('Kick Peon'),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _saveGeneral(PeonSettingsController controller) async {
    final patch = <String, dynamic>{};
    final name = _name.text.trim();
    final heartbeatText = _heartbeat.text.trim();
    final heartbeat = int.tryParse(heartbeatText);

    String? nameError;
    String? heartbeatError;
    if (widget.settings.name != null || name.isNotEmpty) {
      if (name.isEmpty) {
        nameError = 'Name must not be empty.';
      } else {
        patch['name'] = name;
      }
    }
    if (widget.settings.fileTransferRoot != null || _fileRoot.text.isNotEmpty) {
      patch['fileTransferRoot'] = _fileRoot.text;
    }
    if (heartbeatText.isNotEmpty) {
      if (heartbeat == null || heartbeat < 1000 || heartbeat > 60000) {
        heartbeatError = 'Enter a value from 1000 to 60000.';
      } else {
        patch['heartbeatIntervalMs'] = heartbeat;
      }
    }
    if (nameError != null || heartbeatError != null) {
      setState(() {
        _nameError = nameError;
        _heartbeatError = heartbeatError;
      });
      return;
    }

    final saved = await controller.saveSettings(patch);
    if (saved) ref.invalidate(fleetControllerProvider);
  }
}

class _AgentSettings extends ConsumerStatefulWidget {
  const _AgentSettings({
    required this.scope,
    required this.settings,
    required this.state,
  });

  final PeonSettingsScope scope;
  final PeonSettings settings;
  final PeonSettingsState state;

  @override
  ConsumerState<_AgentSettings> createState() => _AgentSettingsState();
}

class _AgentSettingsState extends ConsumerState<_AgentSettings> {
  late String? _agent;
  late String? _model;
  late String? _effort;
  late final TextEditingController _soul;

  @override
  void initState() {
    super.initState();
    final catalog = widget.state.catalog;
    _agent =
        widget.settings.defaultAgent ??
        catalog?.defaultAgent ??
        catalog?.providers.firstOrNull?.agent;
    final provider = _provider;
    _model = _resolveModel(provider, widget.settings.aiDefaultModel);
    _effort = _resolveEffort(
      provider,
      _model,
      widget.settings.aiDefaultReasoningEffort,
    );
    _soul = TextEditingController(text: widget.settings.soul ?? '');
  }

  ModelProvider? get _provider {
    final providers = widget.state.catalog?.providers ?? const [];
    for (final provider in providers) {
      if (provider.agent == _agent) return provider;
    }
    return providers.firstOrNull;
  }

  String? _resolveModel(ModelProvider? provider, String? value) {
    if (provider == null) return null;
    for (final model in provider.models) {
      if (model.id == value || model.alias == value) return value;
    }
    return provider.models.where((model) => model.isDefault).firstOrNull?.id ??
        provider.models.firstOrNull?.id;
  }

  String? _resolveEffort(
    ModelProvider? provider,
    String? model,
    String? value,
  ) {
    if (value == null) return null;
    return reasoningEffortsForModel(
          provider,
          model,
        ).any((effort) => effort.id == value || effort.alias == value)
        ? value
        : null;
  }

  @override
  void dispose() {
    _soul.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.read(
      peonSettingsControllerProvider(widget.scope).notifier,
    );
    final catalog = widget.state.catalog;
    return ListView(
      key: const Key('peon-settings-agent-pane'),
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 32),
      children: [
        _CliUpdatesPanel(scope: widget.scope),
        const SizedBox(height: 12),
        if (catalog != null && catalog.providers.isNotEmpty)
          _SettingsCard(
            title: 'Default agent',
            subtitle:
                'Defaults used when a new session does not override them.',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (catalog.providers.length > 1)
                  _Picker(
                    key: const Key('peon-default-agent'),
                    label: 'AGENT',
                    value: _provider?.label ?? _agent ?? 'Choose agent',
                    onTap: () async {
                      final selected = await _pick<ModelProvider>(
                        context,
                        title: 'Default agent',
                        values: catalog.providers,
                        selected: _provider,
                        label: (value) => value.label,
                      );
                      if (selected == null) return;
                      setState(() {
                        _agent = selected.agent;
                        _model = _resolveModel(selected, _model);
                        _effort = _resolveEffort(selected, _model, _effort);
                      });
                    },
                  ),
                if (catalog.providers.length > 1) const SizedBox(height: 14),
                _Picker(
                  key: const Key('peon-default-model'),
                  label: 'MODEL',
                  value:
                      _provider?.models
                          .where(
                            (model) =>
                                model.id == _model || model.alias == _model,
                          )
                          .firstOrNull
                          ?.label ??
                      _model ??
                      'Choose model',
                  onTap: _provider == null
                      ? null
                      : () async {
                          final models = _provider!.models;
                          final selected = await _pick<ModelCatalogOption>(
                            context,
                            title: 'Default model',
                            values: models,
                            selected: models
                                .where(
                                  (model) =>
                                      model.id == _model ||
                                      model.alias == _model,
                                )
                                .firstOrNull,
                            label: (value) => value.label,
                          );
                          if (selected != null) {
                            setState(() {
                              _model = selected.id;
                              _effort = _resolveEffort(
                                _provider,
                                _model,
                                _effort,
                              );
                            });
                          }
                        },
                ),
                if (reasoningEffortsForModel(_provider, _model).isNotEmpty) ...[
                  const SizedBox(height: 14),
                  _Picker(
                    key: const Key('peon-default-reasoning-effort'),
                    label: 'REASONING EFFORT',
                    value:
                        reasoningEffortsForModel(_provider, _model)
                            .where(
                              (effort) =>
                                  effort.id == _effort ||
                                  effort.alias == _effort,
                            )
                            .firstOrNull
                            ?.label ??
                        'Model default',
                    onTap: () async {
                      final efforts = reasoningEffortsForModel(
                        _provider,
                        _model,
                      );
                      final selected = await _pick<String>(
                        context,
                        title: 'Default reasoning effort',
                        values: ['', ...efforts.map((effort) => effort.id)],
                        selected: _effort ?? '',
                        label: (value) => value.isEmpty
                            ? 'Model default'
                            : efforts
                                  .where((effort) => effort.id == value)
                                  .first
                                  .label,
                      );
                      if (selected == null) return;
                      setState(
                        () => _effort = selected.isEmpty ? null : selected,
                      );
                    },
                  ),
                ],
                const SizedBox(height: 14),
                _SaveRow(
                  loading: widget.state.saving,
                  saved: widget.state.saved,
                  onPressed: () => controller.saveSettings({
                    if (_agent != null) 'defaultAgent': _agent,
                    if (_model != null) 'aiDefaultModel': _model,
                    'aiDefaultReasoningEffort': _effort,
                  }),
                ),
              ],
            ),
          ),
        if (catalog != null && catalog.providers.isNotEmpty)
          const SizedBox(height: 12),
        _SettingsCard(
          title: 'Soul',
          subtitle:
              'Markdown instructions that shape the Peon across its sessions.',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppTextField(
                key: const Key('peon-soul-field'),
                controller: _soul,
                label: 'SOUL MARKDOWN',
                hint: 'Describe how this Peon should think and communicate…',
                mono: true,
                minLines: 12,
                maxLines: 20,
                keyboardType: TextInputType.multiline,
                textInputAction: TextInputAction.newline,
              ),
              const SizedBox(height: 14),
              Row(
                children: [
                  AppButton(
                    variant: AppButtonVariant.ghost,
                    disabled: widget.state.soulSaving && _soul.text.isEmpty,
                    onPressed: () {
                      _soul.clear();
                      controller.saveSoul('');
                    },
                    child: const Text('Clear'),
                  ),
                  const Spacer(),
                  if (widget.state.soulSaved)
                    Text(
                      '⚡ Saved',
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppThemePalette.of(context).accentStrong,
                      ),
                    ),
                  if (widget.state.soulSaved) const SizedBox(width: 10),
                  AppButton(
                    key: const Key('peon-soul-save'),
                    loading: widget.state.soulSaving,
                    onPressed: () => controller.saveSoul(_soul.text),
                    child: const Text('Save Soul'),
                  ),
                ],
              ),
            ],
          ),
        ),
        if (widget.state.message case final message?) ...[
          const SizedBox(height: 12),
          _ErrorText(message),
        ],
      ],
    );
  }
}

class _CliUpdatesPanel extends ConsumerWidget {
  const _CliUpdatesPanel({required this.scope});

  final PeonSettingsScope scope;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(cliUpdatesControllerProvider(scope));
    return _SettingsCard(
      title: 'Provider updates',
      subtitle:
          'Installed CLI versions used by Codex and Claude Code sessions.',
      child: value.when(
        loading: () => Center(
          child: CircularProgressIndicator(
            strokeWidth: 1.7,
            color: AppThemePalette.of(context).accentStrong,
          ),
        ),
        error: (error, _) => _ErrorText(error.toString()),
        data: (state) {
          final controller = ref.read(
            cliUpdatesControllerProvider(scope).notifier,
          );
          if (state.unsupported && state.items.isEmpty) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  'This Peon does not support provider updates. Update the '
                  'Peon itself to enable this panel.',
                  style: AppTypography.mono(
                    fontSize: 11,
                    color: AppThemePalette.of(context).inkFaint,
                    height: 1.45,
                  ),
                ),
                if (scope.online) ...[
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: AppButton(
                      onPressed: controller.refresh,
                      child: const Text('Retry'),
                    ),
                  ),
                ],
              ],
            );
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (!scope.online)
                const _InlineNotice(
                  text: 'Offline · showing the last cached provider status.',
                ),
              for (final item in state.items) ...[
                _CliUpdateCard(
                  item: item,
                  disabled: !scope.online || state.busy,
                  loading: state.starting == item.provider || item.busy,
                  onInstall: () async {
                    final confirmed = await showAppConfirmationBottomSheet(
                      context: context,
                      title: 'Update ${item.provider.label}?',
                      message:
                          'The Peon will run its supported CLI update command. '
                          'New sessions may briefly be unavailable.',
                      confirmLabel: 'Install update',
                    );
                    if (confirmed) controller.start(item.provider);
                  },
                ),
                if (item != state.items.last) const SizedBox(height: 10),
              ],
              if (state.items.isEmpty && !state.unsupported)
                Text(
                  scope.online
                      ? 'No supported CLI providers were reported.'
                      : 'No cached provider update data is available.',
                  style: AppTypography.mono(
                    fontSize: 11,
                    color: AppThemePalette.of(context).inkFaint,
                  ),
                ),
              if (state.message case final message?) ...[
                const SizedBox(height: 10),
                _ErrorText(message),
              ],
              if (scope.online && !state.unsupported) ...[
                const SizedBox(height: 12),
                Align(
                  alignment: Alignment.centerRight,
                  child: AppButton(
                    key: const Key('peon-cli-refresh'),
                    variant: AppButtonVariant.ghost,
                    loading: state.refreshing,
                    disabled: state.busy,
                    onPressed: () => controller.refresh(force: true),
                    child: const Text('Check versions'),
                  ),
                ),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _CliUpdateCard extends StatelessWidget {
  const _CliUpdateCard({
    required this.item,
    required this.disabled,
    required this.loading,
    required this.onInstall,
  });

  final CliUpdateItem item;
  final bool disabled;
  final bool loading;
  final VoidCallback onInstall;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      key: Key('peon-cli-${item.provider.apiValue}'),
      constraints: const BoxConstraints(minHeight: 112),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  item.provider.label,
                  style: AppTypography.display(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              _StatusPill(
                text: loading
                    ? 'UPDATING'
                    : item.updateAvailable == true
                    ? 'AVAILABLE'
                    : 'CURRENT',
                warning: item.updateAvailable == true,
              ),
            ],
          ),
          const SizedBox(height: 9),
          Text(
            'INSTALLED  ${item.currentVersion ?? '—'}\n'
            'LATEST     ${item.latestVersion ?? '—'}',
            style: AppTypography.mono(
              fontSize: 10.5,
              color: colors.onSurfaceVariant,
              height: 1.5,
            ),
          ),
          if (item.error case final error?) ...[
            const SizedBox(height: 8),
            Text(
              '⚠ $error',
              style: AppTypography.mono(fontSize: 10.5, color: colors.error),
            ),
          ],
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: AppButton(
              loading: loading,
              disabled: disabled || item.updateAvailable != true,
              onPressed: onInstall,
              child: Text(
                item.updateAvailable == true ? 'Install update' : 'Up to date',
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ArmorySettings extends ConsumerWidget {
  const _ArmorySettings({required this.scope, required this.peon});

  final PeonSettingsScope scope;
  final Peon peon;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final value = ref.watch(armoryControllerProvider(scope));
    return value.when(
      loading: () => Center(child: CircularProgressIndicator(strokeWidth: 1.7)),
      error: (error, _) => _Notice(
        icon: LucideIcons.cloudOff,
        title: 'Could not load Armory',
        message: error.toString(),
        action: AppButton(
          onPressed: () => ref.invalidate(armoryControllerProvider(scope)),
          child: const Text('Retry'),
        ),
      ),
      data: (state) {
        final controller = ref.read(armoryControllerProvider(scope).notifier);
        if (state.unsupported && state.inventory == null) {
          return _Notice(
            icon: LucideIcons.packageX,
            title: 'Armory is unsupported',
            message:
                'This older Peon does not expose the Armory package contract. '
                'Update the Peon to manage packages.',
            action: scope.online
                ? AppButton(
                    onPressed: controller.refresh,
                    child: const Text('Retry'),
                  )
                : null,
          );
        }
        final inventory = state.inventory;
        return ListView(
          key: const Key('peon-settings-armory-pane'),
          padding: const EdgeInsets.fromLTRB(12, 14, 12, 32),
          children: [
            _SettingsCard(
              title: 'Armory packages',
              subtitle:
                  '${inventory?.total ?? 0} packages for ${peon.displayName}.',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (!scope.online)
                    const _InlineNotice(
                      text: 'Offline · showing the last cached inventory.',
                    ),
                  if (inventory?.registry.source == 'cached')
                    const _InlineNotice(
                      text: 'The Peon is using its cached Armory catalog.',
                    ),
                  if (inventory?.registry.source == 'unavailable')
                    _InlineNotice(
                      text:
                          'Registry unavailable. Installed package records '
                          'remain visible.'
                          '${inventory?.registry.errorMessage == null ? '' : ' ${inventory!.registry.errorMessage}'}',
                      warning: true,
                    ),
                  if (inventory != null && !inventory.registry.official)
                    const _InlineNotice(
                      text: 'This Peon uses a non-default Armory registry.',
                      warning: true,
                    ),
                  if (inventory == null)
                    Text(
                      state.message ??
                          'No cached Armory inventory is available.',
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppThemePalette.of(context).inkFaint,
                      ),
                    ),
                  for (final package in inventory?.packages ?? const []) ...[
                    _ArmoryPackageCard(
                      package: package,
                      online: scope.online,
                      busy: state.busyPackageId != null,
                      active: state.busyPackageId == package.id,
                      operation: state.busyPackageId == package.id
                          ? state.operation
                          : null,
                      onAction: (action) =>
                          _confirmArmory(context, controller, package, action),
                    ),
                    if (package != inventory!.packages.last)
                      const SizedBox(height: 10),
                  ],
                  if (inventory != null && inventory.packages.isEmpty)
                    Text(
                      'No packages are published in this catalog.',
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: AppThemePalette.of(context).inkFaint,
                      ),
                    ),
                  if (state.message case final message?) ...[
                    const SizedBox(height: 10),
                    _ErrorText(message),
                  ],
                  if (scope.online) ...[
                    const SizedBox(height: 12),
                    Align(
                      alignment: Alignment.centerRight,
                      child: AppButton(
                        key: const Key('peon-armory-refresh'),
                        variant: AppButtonVariant.ghost,
                        loading: state.refreshing,
                        disabled: state.busyPackageId != null,
                        onPressed: () => controller.refresh(catalog: true),
                        child: const Text('Refresh catalog'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Future<void> _confirmArmory(
    BuildContext context,
    ArmoryController controller,
    ArmoryPackage package,
    ArmoryAction action,
  ) async {
    final label = switch (action) {
      ArmoryAction.install => 'Install',
      ArmoryAction.update => 'Update',
      ArmoryAction.uninstall => 'Uninstall',
      ArmoryAction.enable => 'Enable',
      ArmoryAction.disable => 'Disable',
    };
    final destructive = action == ArmoryAction.uninstall;
    final message = destructive
        ? 'This removes the package runtime. Credentials, managed home, '
              'configuration, and ownership metadata are preserved.'
        : action == ArmoryAction.disable
        ? 'The package runtime will stop and its tools will become unavailable.'
        : '$label ${package.displayName ?? package.id} on this Peon?';
    final confirmed = await showAppConfirmationBottomSheet(
      context: context,
      title: '$label ${package.displayName ?? package.id}?',
      message: message,
      confirmLabel: label,
      destructive: destructive,
    );
    if (confirmed) controller.mutate(package.id, action);
  }
}

class _ArmoryPackageCard extends StatelessWidget {
  const _ArmoryPackageCard({
    required this.package,
    required this.online,
    required this.busy,
    required this.active,
    required this.operation,
    required this.onAction,
  });

  final ArmoryPackage package;
  final bool online;
  final bool busy;
  final bool active;
  final ArmoryOperation? operation;
  final ValueChanged<ArmoryAction> onAction;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final installed = package.installed;
    final configured =
        installed?.configurationStatus == 'verified' ||
        installed?.configurationStatus == 'not_required';
    return Container(
      key: Key('armory-package-${package.id}'),
      constraints: const BoxConstraints(minHeight: 132),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        border: Border.all(
          color: installed?.enabled == true
              ? colors.primary.withValues(alpha: 0.5)
              : colors.outlineVariant,
        ),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                LucideIcons.package,
                size: 19,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(width: 9),
              Expanded(
                child: Text(
                  package.displayName ?? package.id,
                  style: AppTypography.display(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              _StatusPill(
                text: installed == null
                    ? 'AVAILABLE'
                    : installed.enabled
                    ? 'ENABLED'
                    : 'DISABLED',
                warning: installed != null && !installed.enabled,
              ),
            ],
          ),
          if (package.summary case final summary?) ...[
            const SizedBox(height: 8),
            Text(
              summary,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                fontSize: 11,
                color: colors.onSurfaceVariant,
                height: 1.35,
              ),
            ),
          ],
          const SizedBox(height: 8),
          Text(
            installed == null
                ? 'Latest ${package.latestVersion ?? 'unknown'}'
                : 'Installed ${installed.version}'
                      '${package.latestVersion == null ? '' : ' · Latest ${package.latestVersion}'}',
            style: AppTypography.mono(
              fontSize: 10.5,
              color: colors.onSurfaceVariant,
            ),
          ),
          if (active) ...[
            const SizedBox(height: 10),
            _InlineStatus(
              text:
                  '${operation?.kind ?? 'Package operation'} · '
                  '${operation?.progress == null ? operation?.status ?? 'starting' : '${operation!.progress}%'}',
            ),
          ],
          if (installed?.lastError != null) ...[
            const SizedBox(height: 8),
            Text(
              '⚠ The latest package operation failed.',
              style: TextStyle(color: colors.error, fontSize: 11),
            ),
          ],
          const SizedBox(height: 10),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              if (installed == null)
                AppButton(
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.secondary,
                  disabled: !online || busy || !package.available,
                  onPressed: () => onAction(ArmoryAction.install),
                  child: const Text('Install'),
                )
              else ...[
                AppButton(
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.secondary,
                  disabled:
                      !online || busy || (!installed.enabled && !configured),
                  onPressed: () => onAction(
                    installed.enabled
                        ? ArmoryAction.disable
                        : ArmoryAction.enable,
                  ),
                  child: Text(installed.enabled ? 'Disable' : 'Enable'),
                ),
                if (package.updateAvailable == true)
                  AppButton(
                    size: AppButtonSize.sm,
                    variant: AppButtonVariant.secondary,
                    disabled: !online || busy,
                    onPressed: () => onAction(ArmoryAction.update),
                    child: const Text('Update'),
                  ),
                AppButton(
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.dangerGhost,
                  disabled: !online || busy,
                  onPressed: () => onAction(ArmoryAction.uninstall),
                  child: const Text('Uninstall'),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  const _StatusPill({required this.text, this.warning = false});

  final String text;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final tone = warning ? colors.tertiary : colors.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
      decoration: BoxDecoration(
        color: tone.withValues(alpha: 0.1),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: tone.withValues(alpha: 0.45)),
      ),
      child: Text(text, style: AppTypography.mono(fontSize: 8.5, color: tone)),
    );
  }
}

class _InlineNotice extends StatelessWidget {
  const _InlineNotice({required this.text, this.warning = false});

  final String text;
  final bool warning;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 10),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color:
          (warning
                  ? AppThemePalette.of(context).warning
                  : AppThemePalette.of(context).accent)
              .withValues(alpha: 0.06),
      border: Border(
        left: BorderSide(
          color: warning
              ? AppThemePalette.of(context).warning
              : AppThemePalette.of(context).accent,
          width: 2,
        ),
      ),
    ),
    child: Text(
      text,
      style: AppTypography.mono(
        fontSize: 10.5,
        color: warning
            ? AppThemePalette.of(context).warningStrong
            : AppThemePalette.of(context).inkMuted,
      ),
    ),
  );
}

Future<T?> _pick<T>(
  BuildContext context, {
  required String title,
  required List<T> values,
  required T? selected,
  required String Function(T) label,
}) => showAppOptionBottomSheet<T>(
  context: context,
  builder: (context) => AppOptionBottomSheet(
    title: title,
    children: [
      for (final value in values)
        AppOptionSheetTile(
          selected: identical(value, selected),
          onTap: () => Navigator.of(context).pop(value),
          child: Text(
            label(value),
            style: AppTypography.body(
              fontSize: 14,
              color: AppThemePalette.of(context).ink,
            ),
          ),
        ),
    ],
  ),
);

class _Picker extends StatelessWidget {
  const _Picker({
    super.key,
    required this.label,
    required this.value,
    required this.onTap,
  });

  final String label;
  final String value;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: AppTypography.display(
            fontSize: 10,
            fontWeight: FontWeight.w700,
            letterSpacing: 2,
            color: colors.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 5),
        Material(
          color: colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(8),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(8),
            child: Container(
              height: 44,
              padding: const EdgeInsets.symmetric(horizontal: 12),
              decoration: BoxDecoration(
                border: Border.all(color: colors.outlineVariant),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      value,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.body(
                        fontSize: 14,
                        color: colors.onSurface,
                      ),
                    ),
                  ),
                  Icon(
                    LucideIcons.chevronDown,
                    size: 15,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SettingsCard extends StatelessWidget {
  const _SettingsCard({
    required this.title,
    required this.subtitle,
    required this.child,
  });

  final String title;
  final String subtitle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title, style: AppTypography.entityTitle()),
          const SizedBox(height: 4),
          Text(
            subtitle,
            style: AppTypography.body(
              fontSize: 12,
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 16),
          child,
        ],
      ),
    );
  }
}

class _SaveRow extends StatelessWidget {
  const _SaveRow({
    required this.loading,
    required this.saved,
    required this.onPressed,
  });

  final bool loading;
  final bool saved;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        if (saved)
          Text(
            '⚡ Saved',
            style: AppTypography.mono(
              fontSize: 11,
              color: Theme.of(context).colorScheme.primary,
            ),
          ),
        if (saved) const SizedBox(width: 10),
        AppButton(
          key: const Key('peon-settings-save'),
          loading: loading,
          onPressed: onPressed,
          child: const Text('Save changes'),
        ),
      ],
    );
  }
}

class _Detail extends StatelessWidget {
  const _Detail({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 4),
    child: Text(
      '$label  $value',
      style: AppTypography.mono(
        fontSize: 10.5,
        color: Theme.of(context).colorScheme.onSurfaceVariant,
      ),
    ),
  );
}

class _InlineStatus extends StatelessWidget {
  const _InlineStatus({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.07),
      border: Border(
        left: BorderSide(
          color: Theme.of(context).colorScheme.primary,
          width: 2,
        ),
      ),
    ),
    child: Text(
      text,
      style: AppTypography.mono(
        fontSize: 11,
        color: Theme.of(context).colorScheme.primary,
      ),
    ),
  );
}

class _ErrorText extends StatelessWidget {
  const _ErrorText(this.message);

  final String message;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.error.withValues(alpha: 0.06),
      border: Border(
        left: BorderSide(color: Theme.of(context).colorScheme.error, width: 2),
      ),
    ),
    child: Text(
      '⚠ $message',
      style: AppTypography.mono(
        fontSize: 11,
        color: Theme.of(context).colorScheme.error,
      ),
    ),
  );
}
