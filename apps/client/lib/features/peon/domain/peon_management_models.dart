class ArmoryRegistry {
  const ArmoryRegistry({
    required this.source,
    required this.official,
    this.fetchedAt,
    this.errorCode,
    this.errorMessage,
  });

  final String source;
  final bool official;
  final double? fetchedAt;
  final String? errorCode;
  final String? errorMessage;

  factory ArmoryRegistry.fromJson(Map<String, dynamic> json) {
    final error = _map(json['error']);
    return ArmoryRegistry(
      source: json['source'] as String? ?? 'unavailable',
      official: json['official'] as bool? ?? true,
      fetchedAt: (json['fetchedAt'] as num?)?.toDouble(),
      errorCode: error?['code'] as String?,
      errorMessage: error?['message'] as String?,
    );
  }
}

class InstalledArmoryPackage {
  const InstalledArmoryPackage({
    required this.version,
    required this.enabled,
    required this.state,
    required this.configurationStatus,
    this.lastError,
    this.activeOperationId,
  });

  final String version;
  final bool enabled;
  final String state;
  final String configurationStatus;
  final String? lastError;
  final String? activeOperationId;

  factory InstalledArmoryPackage.fromJson(Map<String, dynamic> json) =>
      InstalledArmoryPackage(
        version: json['version'] as String? ?? 'unknown',
        enabled: json['enabled'] as bool? ?? false,
        state: json['state'] as String? ?? 'error',
        configurationStatus:
            json['configurationStatus'] as String? ?? 'invalid',
        lastError: json['lastError'] as String?,
        activeOperationId: json['activeOperationId'] as String?,
      );
}

class ArmoryPackage {
  const ArmoryPackage({
    required this.id,
    required this.available,
    required this.updateAvailable,
    this.displayName,
    this.summary,
    this.latestVersion,
    this.installed,
  });

  final String id;
  final bool available;
  final bool? updateAvailable;
  final String? displayName;
  final String? summary;
  final String? latestVersion;
  final InstalledArmoryPackage? installed;

  factory ArmoryPackage.fromJson(Map<String, dynamic> json) {
    final installed = _map(json['installed']);
    return ArmoryPackage(
      id: json['id'] as String? ?? '',
      available: json['available'] as bool? ?? false,
      updateAvailable: json['updateAvailable'] as bool?,
      displayName: json['displayName'] as String?,
      summary: json['summary'] as String?,
      latestVersion: json['latestVersion'] as String?,
      installed: installed == null
          ? null
          : InstalledArmoryPackage.fromJson(installed),
    );
  }
}

class ArmoryInventory {
  const ArmoryInventory({
    required this.registry,
    required this.packages,
    required this.total,
    this.cachedAt,
  });

  final ArmoryRegistry registry;
  final List<ArmoryPackage> packages;
  final int total;
  final double? cachedAt;

  factory ArmoryInventory.fromJson(Map<String, dynamic> json) =>
      ArmoryInventory(
        registry: ArmoryRegistry.fromJson(_map(json['registry']) ?? const {}),
        packages: (json['packages'] as List? ?? const [])
            .whereType<Map>()
            .map(
              (value) =>
                  ArmoryPackage.fromJson(Map<String, dynamic>.from(value)),
            )
            .where((value) => value.id.isNotEmpty)
            .toList(growable: false),
        total: (json['total'] as num?)?.toInt() ?? 0,
        cachedAt: (json['_cachedAt'] as num?)?.toDouble(),
      );

  Map<String, dynamic> toJson() => {
    'registry': {
      'source': registry.source,
      'official': registry.official,
      'fetchedAt': registry.fetchedAt,
      'error': registry.errorCode == null && registry.errorMessage == null
          ? null
          : {'code': registry.errorCode, 'message': registry.errorMessage},
    },
    'packages': [
      for (final item in packages)
        {
          'id': item.id,
          'available': item.available,
          'updateAvailable': item.updateAvailable,
          'displayName': item.displayName,
          'summary': item.summary,
          'latestVersion': item.latestVersion,
          'installed': item.installed == null
              ? null
              : {
                  'version': item.installed!.version,
                  'enabled': item.installed!.enabled,
                  'state': item.installed!.state,
                  'configurationStatus': item.installed!.configurationStatus,
                  'lastError': item.installed!.lastError,
                  'activeOperationId': item.installed!.activeOperationId,
                },
        },
    ],
    'total': total,
    '_cachedAt': cachedAt,
  };
}

class ArmoryOperation {
  const ArmoryOperation({
    required this.id,
    required this.status,
    required this.kind,
    this.progress,
    this.message,
    this.errorCode,
  });

  final String id;
  final String status;
  final String kind;
  final int? progress;
  final String? message;
  final String? errorCode;

  bool get active => status == 'queued' || status == 'running';

  factory ArmoryOperation.fromJson(Map<String, dynamic> json) =>
      ArmoryOperation(
        id: json['id'] as String? ?? '',
        status: json['status'] as String? ?? 'failure',
        kind: json['kind'] as String? ?? 'unknown',
        progress: (json['progress'] as num?)?.toInt(),
        message: json['message'] as String?,
        errorCode: json['errorCode'] as String?,
      );
}

enum CliProvider {
  codex('codex', 'Codex CLI'),
  claudeCode('claude-code', 'Claude Code');

  const CliProvider(this.apiValue, this.label);
  final String apiValue;
  final String label;
}

class CliUpdateItem {
  const CliUpdateItem({
    required this.provider,
    this.currentVersion,
    this.latestVersion,
    this.updateAvailable,
    this.installationKind,
    this.updateSupported,
    this.updateReason,
    this.checkedAt,
    this.status = 'idle',
    this.error,
  });

  final CliProvider provider;
  final String? currentVersion;
  final String? latestVersion;
  final bool? updateAvailable;
  final String? installationKind;
  final bool? updateSupported;
  final String? updateReason;
  final double? checkedAt;
  final String status;
  final String? error;

  bool get busy => const {
    'queued',
    'running',
    'installing',
    'updating',
    'starting',
  }.contains(status.toLowerCase());

  factory CliUpdateItem.fromJson(
    Map<String, dynamic> json, {
    CliProvider? hint,
  }) {
    final rawProvider =
        hint?.apiValue ??
        json['provider'] ??
        json['id'] ??
        json['agent'] ??
        json['tool'] ??
        json['name'];
    final provider =
        rawProvider == 'claude-code' ||
            rawProvider == 'claudeCode' ||
            rawProvider == 'claude'
        ? CliProvider.claudeCode
        : CliProvider.codex;
    final operation = _map(
      json['operation'] ?? json['update'] ?? json['action'],
    );
    final status =
        _text(
          operation?['status'],
          operation?['state'],
          json['updateStatus'],
          json['status'],
        ) ??
        'idle';
    final failed = status == 'failed' || status == 'failure';
    final current = _text(
      json['currentVersion'],
      json['installedVersion'],
      json['current'],
      json['version'],
    );
    final latest = _text(
      json['latestVersion'],
      json['availableVersion'],
      json['latest'],
    );
    return CliUpdateItem(
      provider: provider,
      currentVersion: current,
      latestVersion: latest,
      updateAvailable:
          json['updateAvailable'] as bool? ??
          (current != null && latest != null ? current != latest : null),
      installationKind: _text(json['installationKind']),
      updateSupported: json['updateSupported'] as bool?,
      updateReason: _text(json['updateReason']),
      checkedAt: _timestamp(
        json['checkedAt'] ?? json['lastCheckedAt'] ?? json['refreshedAt'],
      ),
      status: status,
      error: _text(
        operation?['error'],
        json['updateReason'],
        json['updateError'],
        json['checkError'],
        _text(
          json['error'],
          failed && operation != null ? operation['message'] : null,
        ),
      ),
    );
  }

  Map<String, dynamic> toJson() => {
    'provider': provider.apiValue,
    'currentVersion': currentVersion,
    'latestVersion': latestVersion,
    'updateAvailable': updateAvailable,
    'installationKind': installationKind,
    'updateSupported': updateSupported,
    'updateReason': updateReason,
    'checkedAt': checkedAt,
    'status': status,
    'error': error,
  };
}

Map<String, dynamic>? _map(Object? value) =>
    value is Map ? Map<String, dynamic>.from(value) : null;

String? _text(Object? a, [Object? b, Object? c, Object? d, Object? e]) {
  for (final value in [a, b, c, d, e]) {
    if (value is String && value.trim().isNotEmpty) return value;
  }
  return null;
}

double? _timestamp(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) {
    return DateTime.tryParse(value)?.millisecondsSinceEpoch.toDouble();
  }
  return null;
}
