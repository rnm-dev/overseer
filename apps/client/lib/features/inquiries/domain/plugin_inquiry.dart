enum PluginInquiryStatus {
  pending,
  installing,
  installed,
  authRequired,
  expired,
  cancelled,
  refused,
  failed,
  stale;

  static PluginInquiryStatus parse(String value) => switch (value) {
    'pending' => pending,
    'installing' => installing,
    'installed' => installed,
    'auth_required' => authRequired,
    'expired' => expired,
    'cancelled' => cancelled,
    'failed' => failed,
    _ => throw const FormatException('Unsupported inquiry status'),
  };

  bool get isActionable => this == pending;
}

class PluginIdentity {
  const PluginIdentity({
    required this.id,
    required this.name,
    required this.displayName,
    required this.authPolicy,
    required this.installPolicy,
    required this.installed,
    this.developerName,
    this.category,
    this.description,
    this.capabilities = const [],
  });

  final String id;
  final String name;
  final String displayName;
  final String authPolicy;
  final String installPolicy;
  final bool installed;
  final String? developerName;
  final String? category;
  final String? description;
  final List<String> capabilities;

  factory PluginIdentity.fromJson(Map<String, dynamic> json) {
    final installed = json['installed'];
    if (installed is! bool) throw const FormatException('Missing installed');
    return PluginIdentity(
      id: _requiredString(json, 'id'),
      name: _requiredString(json, 'name'),
      displayName: _requiredString(json, 'displayName'),
      authPolicy: _requiredString(json, 'authPolicy'),
      installPolicy: _requiredString(json, 'installPolicy'),
      installed: installed,
      developerName: _optionalString(json['developerName']),
      category: _optionalString(json['category']),
      description: _optionalString(json['description']),
      capabilities: (json['capabilities'] as List? ?? const [])
          .whereType<String>()
          .toList(growable: false),
    );
  }
}

class PluginAuthApp {
  const PluginAuthApp({
    required this.id,
    required this.name,
    this.category,
    this.description,
  });
  final String id;
  final String name;
  final String? category;
  final String? description;

  factory PluginAuthApp.fromJson(Map<String, dynamic> json) => PluginAuthApp(
    id: _requiredString(json, 'id'),
    name: _requiredString(json, 'name'),
    category: _optionalString(json['category']),
    description: _optionalString(json['description']),
  );
}

class PluginInstallInquiry {
  const PluginInstallInquiry({
    required this.inquiryId,
    required this.status,
    required this.plugin,
    required this.expiresAt,
    this.errorCode,
    this.authPolicy,
    this.appsNeedingAuth = const [],
  });

  final String inquiryId;
  final PluginInquiryStatus status;
  final PluginIdentity plugin;
  final DateTime expiresAt;
  final String? errorCode;
  final String? authPolicy;
  final List<PluginAuthApp> appsNeedingAuth;

  bool expiredAt(DateTime now) =>
      status == PluginInquiryStatus.pending && !expiresAt.isAfter(now);
  PluginInstallInquiry effectiveAt(DateTime now) =>
      expiredAt(now) ? copyWith(status: PluginInquiryStatus.expired) : this;

  PluginInstallInquiry copyWith({PluginInquiryStatus? status}) =>
      PluginInstallInquiry(
        inquiryId: inquiryId,
        status: status ?? this.status,
        plugin: plugin,
        expiresAt: expiresAt,
        errorCode: errorCode,
        authPolicy: authPolicy,
        appsNeedingAuth: appsNeedingAuth,
      );

  factory PluginInstallInquiry.fromJson(Map<String, dynamic> json) {
    if (json['version'] != 'inquiry-v1' ||
        json['kind'] != 'managed_plugin_install') {
      throw const FormatException('Unsupported inquiry envelope');
    }
    final plugin = json['plugin'];
    final expiresAt = DateTime.tryParse(_requiredString(json, 'expiresAt'));
    if (plugin is! Map || expiresAt == null) {
      throw const FormatException('Invalid inquiry envelope');
    }
    final terminalCode = _optionalString(json['terminalCode']);
    final wireStatus = PluginInquiryStatus.parse(
      _requiredString(json, 'status'),
    );
    final apps = json['appsNeedingAuth'];
    return PluginInstallInquiry(
      inquiryId: _requiredString(json, 'inquiryId'),
      status:
          wireStatus == PluginInquiryStatus.failed &&
              {
                'INQUIRY_RUNTIME_LOST',
                'INQUIRY_STALE_GENERATION',
                'INQUIRY_TURN_ENDED',
              }.contains(terminalCode)
          ? PluginInquiryStatus.stale
          : wireStatus,
      plugin: PluginIdentity.fromJson(Map<String, dynamic>.from(plugin)),
      expiresAt: expiresAt.toUtc(),
      errorCode: terminalCode,
      authPolicy: _optionalString(json['authPolicy']),
      appsNeedingAuth: apps is List
          ? apps
                .whereType<Map>()
                .map(
                  (app) =>
                      PluginAuthApp.fromJson(Map<String, dynamic>.from(app)),
                )
                .toList(growable: false)
          : const [],
    );
  }
}

String _requiredString(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! String || value.trim().isEmpty) {
    throw FormatException('Missing $key');
  }
  return value;
}

String? _optionalString(Object? value) =>
    value is String && value.trim().isNotEmpty ? value : null;
