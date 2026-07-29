import '../../../shared/models/ai_capabilities.dart';

class PeonSettingsScope {
  const PeonSettingsScope({
    required this.workspaceId,
    required this.peonId,
    required this.online,
  });

  final String workspaceId;
  final String peonId;
  final bool online;

  @override
  bool operator ==(Object other) =>
      other is PeonSettingsScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.online == online;

  @override
  int get hashCode => Object.hash(workspaceId, peonId, online);
}

class PeonSettings {
  const PeonSettings({
    this.name,
    this.fileTransferRoot,
    this.heartbeatIntervalMs,
    this.aiDefaultModel,
    this.defaultAgent,
    this.soul,
  });

  final String? name;
  final String? fileTransferRoot;
  final int? heartbeatIntervalMs;
  final String? aiDefaultModel;
  final String? defaultAgent;
  final String? soul;

  factory PeonSettings.fromJson(Map<String, dynamic> json) => PeonSettings(
    name: json['name'] as String?,
    fileTransferRoot: json['fileTransferRoot'] as String?,
    heartbeatIntervalMs: (json['heartbeatIntervalMs'] as num?)?.toInt(),
    aiDefaultModel: json['aiDefaultModel'] as String?,
    defaultAgent: json['defaultAgent'] as String?,
    soul: switch (json['soul']) {
      final String value when value.isNotEmpty => value,
      _ => null,
    },
  );

  Map<String, dynamic> toPatch({
    bool includeGeneral = true,
    bool includeAgent = true,
  }) => {
    if (includeGeneral) ...{
      if (name != null) 'name': name,
      if (fileTransferRoot != null) 'fileTransferRoot': fileTransferRoot,
      if (heartbeatIntervalMs != null)
        'heartbeatIntervalMs': heartbeatIntervalMs,
    },
    if (includeAgent) ...{
      if (defaultAgent != null) 'defaultAgent': defaultAgent,
      if (aiDefaultModel != null) 'aiDefaultModel': aiDefaultModel,
    },
  };
}

class PeonStatus {
  const PeonStatus({
    required this.updateAvailable,
    this.updateLocalSha,
    this.updateRemoteSha,
    this.updateCheckedAt,
    this.updateCheckError,
  });

  final bool updateAvailable;
  final String? updateLocalSha;
  final String? updateRemoteSha;
  final double? updateCheckedAt;
  final String? updateCheckError;

  factory PeonStatus.fromJson(Map<String, dynamic> json) => PeonStatus(
    updateAvailable: json['updateAvailable'] as bool? ?? false,
    updateLocalSha: json['updateLocalSha'] as String?,
    updateRemoteSha: json['updateRemoteSha'] as String?,
    updateCheckedAt: (json['updateCheckedAt'] as num?)?.toDouble(),
    updateCheckError: json['updateCheckError'] as String?,
  );
}

enum PeonUpdatePhase { idle, installing, restarting, complete }

class PeonSettingsState {
  const PeonSettingsState({
    this.settings,
    this.status,
    this.catalog,
    this.unsupported = false,
    this.saving = false,
    this.saved = false,
    this.connectionSaving = false,
    this.connectionSaved = false,
    this.soulSaving = false,
    this.soulSaved = false,
    this.deleting = false,
    this.checkingUpdate = false,
    this.updatePhase = PeonUpdatePhase.idle,
    this.loadMessage,
    this.message,
  });

  final PeonSettings? settings;
  final PeonStatus? status;
  final ModelsCatalog? catalog;
  final bool unsupported;
  final bool saving;
  final bool saved;
  final bool connectionSaving;
  final bool connectionSaved;
  final bool soulSaving;
  final bool soulSaved;
  final bool deleting;
  final bool checkingUpdate;
  final PeonUpdatePhase updatePhase;
  final String? loadMessage;
  final String? message;

  PeonSettingsState copyWith({
    PeonSettings? settings,
    PeonStatus? status,
    ModelsCatalog? catalog,
    bool? unsupported,
    bool? saving,
    bool? saved,
    bool? connectionSaving,
    bool? connectionSaved,
    bool? soulSaving,
    bool? soulSaved,
    bool? deleting,
    bool? checkingUpdate,
    PeonUpdatePhase? updatePhase,
    String? loadMessage,
    String? message,
    bool clearMessage = false,
  }) => PeonSettingsState(
    settings: settings ?? this.settings,
    status: status ?? this.status,
    catalog: catalog ?? this.catalog,
    unsupported: unsupported ?? this.unsupported,
    saving: saving ?? this.saving,
    saved: saved ?? this.saved,
    connectionSaving: connectionSaving ?? this.connectionSaving,
    connectionSaved: connectionSaved ?? this.connectionSaved,
    soulSaving: soulSaving ?? this.soulSaving,
    soulSaved: soulSaved ?? this.soulSaved,
    deleting: deleting ?? this.deleting,
    checkingUpdate: checkingUpdate ?? this.checkingUpdate,
    updatePhase: updatePhase ?? this.updatePhase,
    loadMessage: loadMessage ?? this.loadMessage,
    message: clearMessage ? null : message ?? this.message,
  );
}
