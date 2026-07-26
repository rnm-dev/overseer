// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'app_database.dart';

// ignore_for_file: type=lint
class $CachedSessionsTable extends CachedSessions
    with TableInfo<$CachedSessionsTable, CachedSession> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedSessionsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _statusMeta = const VerificationMeta('status');
  @override
  late final GeneratedColumn<String> status = GeneratedColumn<String>(
    'status',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _projectKeyMeta = const VerificationMeta(
    'projectKey',
  );
  @override
  late final GeneratedColumn<String> projectKey = GeneratedColumn<String>(
    'project_key',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _projectIdMeta = const VerificationMeta(
    'projectId',
  );
  @override
  late final GeneratedColumn<String> projectId = GeneratedColumn<String>(
    'project_id',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _titleMeta = const VerificationMeta('title');
  @override
  late final GeneratedColumn<String> title = GeneratedColumn<String>(
    'title',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _promptPreviewMeta = const VerificationMeta(
    'promptPreview',
  );
  @override
  late final GeneratedColumn<String> promptPreview = GeneratedColumn<String>(
    'prompt_preview',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _previewMeta = const VerificationMeta(
    'preview',
  );
  @override
  late final GeneratedColumn<String> preview = GeneratedColumn<String>(
    'preview',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _authorMeta = const VerificationMeta('author');
  @override
  late final GeneratedColumn<String> author = GeneratedColumn<String>(
    'author',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _outcomeJsonMeta = const VerificationMeta(
    'outcomeJson',
  );
  @override
  late final GeneratedColumn<String> outcomeJson = GeneratedColumn<String>(
    'outcome_json',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _startedAtMeta = const VerificationMeta(
    'startedAt',
  );
  @override
  late final GeneratedColumn<double> startedAt = GeneratedColumn<double>(
    'started_at',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _endedAtMeta = const VerificationMeta(
    'endedAt',
  );
  @override
  late final GeneratedColumn<double> endedAt = GeneratedColumn<double>(
    'ended_at',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _lastActivityAtMeta = const VerificationMeta(
    'lastActivityAt',
  );
  @override
  late final GeneratedColumn<double> lastActivityAt = GeneratedColumn<double>(
    'last_activity_at',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<double> syncedAt = GeneratedColumn<double>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _attentionUnreadMeta = const VerificationMeta(
    'attentionUnread',
  );
  @override
  late final GeneratedColumn<bool> attentionUnread = GeneratedColumn<bool>(
    'attention_unread',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("attention_unread" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _attentionUpdatedAtMeta =
      const VerificationMeta('attentionUpdatedAt');
  @override
  late final GeneratedColumn<double> attentionUpdatedAt =
      GeneratedColumn<double>(
        'attention_updated_at',
        aliasedName,
        false,
        type: DriftSqlType.double,
        requiredDuringInsert: false,
        defaultValue: const Constant(0),
      );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    sessionId,
    status,
    projectKey,
    projectId,
    title,
    promptPreview,
    preview,
    author,
    outcomeJson,
    startedAt,
    endedAt,
    lastActivityAt,
    syncedAt,
    attentionUnread,
    attentionUpdatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_sessions';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedSession> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('status')) {
      context.handle(
        _statusMeta,
        status.isAcceptableOrUnknown(data['status']!, _statusMeta),
      );
    }
    if (data.containsKey('project_key')) {
      context.handle(
        _projectKeyMeta,
        projectKey.isAcceptableOrUnknown(data['project_key']!, _projectKeyMeta),
      );
    }
    if (data.containsKey('project_id')) {
      context.handle(
        _projectIdMeta,
        projectId.isAcceptableOrUnknown(data['project_id']!, _projectIdMeta),
      );
    }
    if (data.containsKey('title')) {
      context.handle(
        _titleMeta,
        title.isAcceptableOrUnknown(data['title']!, _titleMeta),
      );
    }
    if (data.containsKey('prompt_preview')) {
      context.handle(
        _promptPreviewMeta,
        promptPreview.isAcceptableOrUnknown(
          data['prompt_preview']!,
          _promptPreviewMeta,
        ),
      );
    }
    if (data.containsKey('preview')) {
      context.handle(
        _previewMeta,
        preview.isAcceptableOrUnknown(data['preview']!, _previewMeta),
      );
    }
    if (data.containsKey('author')) {
      context.handle(
        _authorMeta,
        author.isAcceptableOrUnknown(data['author']!, _authorMeta),
      );
    }
    if (data.containsKey('outcome_json')) {
      context.handle(
        _outcomeJsonMeta,
        outcomeJson.isAcceptableOrUnknown(
          data['outcome_json']!,
          _outcomeJsonMeta,
        ),
      );
    }
    if (data.containsKey('started_at')) {
      context.handle(
        _startedAtMeta,
        startedAt.isAcceptableOrUnknown(data['started_at']!, _startedAtMeta),
      );
    }
    if (data.containsKey('ended_at')) {
      context.handle(
        _endedAtMeta,
        endedAt.isAcceptableOrUnknown(data['ended_at']!, _endedAtMeta),
      );
    }
    if (data.containsKey('last_activity_at')) {
      context.handle(
        _lastActivityAtMeta,
        lastActivityAt.isAcceptableOrUnknown(
          data['last_activity_at']!,
          _lastActivityAtMeta,
        ),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_syncedAtMeta);
    }
    if (data.containsKey('attention_unread')) {
      context.handle(
        _attentionUnreadMeta,
        attentionUnread.isAcceptableOrUnknown(
          data['attention_unread']!,
          _attentionUnreadMeta,
        ),
      );
    }
    if (data.containsKey('attention_updated_at')) {
      context.handle(
        _attentionUpdatedAtMeta,
        attentionUpdatedAt.isAcceptableOrUnknown(
          data['attention_updated_at']!,
          _attentionUpdatedAtMeta,
        ),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId, sessionId};
  @override
  CachedSession map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedSession(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      status: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}status'],
      ),
      projectKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}project_key'],
      ),
      projectId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}project_id'],
      ),
      title: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}title'],
      ),
      promptPreview: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}prompt_preview'],
      ),
      preview: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}preview'],
      ),
      author: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}author'],
      ),
      outcomeJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}outcome_json'],
      ),
      startedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}started_at'],
      ),
      endedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}ended_at'],
      ),
      lastActivityAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}last_activity_at'],
      ),
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}synced_at'],
      )!,
      attentionUnread: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}attention_unread'],
      )!,
      attentionUpdatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}attention_updated_at'],
      )!,
    );
  }

  @override
  $CachedSessionsTable createAlias(String alias) {
    return $CachedSessionsTable(attachedDatabase, alias);
  }
}

class CachedSession extends DataClass implements Insertable<CachedSession> {
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String? status;
  final String? projectKey;
  final String? projectId;
  final String? title;
  final String? promptPreview;
  final String? preview;
  final String? author;
  final String? outcomeJson;
  final double? startedAt;
  final double? endedAt;
  final double? lastActivityAt;
  final double syncedAt;
  final bool attentionUnread;
  final double attentionUpdatedAt;
  const CachedSession({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    this.status,
    this.projectKey,
    this.projectId,
    this.title,
    this.promptPreview,
    this.preview,
    this.author,
    this.outcomeJson,
    this.startedAt,
    this.endedAt,
    this.lastActivityAt,
    required this.syncedAt,
    required this.attentionUnread,
    required this.attentionUpdatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['session_id'] = Variable<String>(sessionId);
    if (!nullToAbsent || status != null) {
      map['status'] = Variable<String>(status);
    }
    if (!nullToAbsent || projectKey != null) {
      map['project_key'] = Variable<String>(projectKey);
    }
    if (!nullToAbsent || projectId != null) {
      map['project_id'] = Variable<String>(projectId);
    }
    if (!nullToAbsent || title != null) {
      map['title'] = Variable<String>(title);
    }
    if (!nullToAbsent || promptPreview != null) {
      map['prompt_preview'] = Variable<String>(promptPreview);
    }
    if (!nullToAbsent || preview != null) {
      map['preview'] = Variable<String>(preview);
    }
    if (!nullToAbsent || author != null) {
      map['author'] = Variable<String>(author);
    }
    if (!nullToAbsent || outcomeJson != null) {
      map['outcome_json'] = Variable<String>(outcomeJson);
    }
    if (!nullToAbsent || startedAt != null) {
      map['started_at'] = Variable<double>(startedAt);
    }
    if (!nullToAbsent || endedAt != null) {
      map['ended_at'] = Variable<double>(endedAt);
    }
    if (!nullToAbsent || lastActivityAt != null) {
      map['last_activity_at'] = Variable<double>(lastActivityAt);
    }
    map['synced_at'] = Variable<double>(syncedAt);
    map['attention_unread'] = Variable<bool>(attentionUnread);
    map['attention_updated_at'] = Variable<double>(attentionUpdatedAt);
    return map;
  }

  CachedSessionsCompanion toCompanion(bool nullToAbsent) {
    return CachedSessionsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      sessionId: Value(sessionId),
      status: status == null && nullToAbsent
          ? const Value.absent()
          : Value(status),
      projectKey: projectKey == null && nullToAbsent
          ? const Value.absent()
          : Value(projectKey),
      projectId: projectId == null && nullToAbsent
          ? const Value.absent()
          : Value(projectId),
      title: title == null && nullToAbsent
          ? const Value.absent()
          : Value(title),
      promptPreview: promptPreview == null && nullToAbsent
          ? const Value.absent()
          : Value(promptPreview),
      preview: preview == null && nullToAbsent
          ? const Value.absent()
          : Value(preview),
      author: author == null && nullToAbsent
          ? const Value.absent()
          : Value(author),
      outcomeJson: outcomeJson == null && nullToAbsent
          ? const Value.absent()
          : Value(outcomeJson),
      startedAt: startedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(startedAt),
      endedAt: endedAt == null && nullToAbsent
          ? const Value.absent()
          : Value(endedAt),
      lastActivityAt: lastActivityAt == null && nullToAbsent
          ? const Value.absent()
          : Value(lastActivityAt),
      syncedAt: Value(syncedAt),
      attentionUnread: Value(attentionUnread),
      attentionUpdatedAt: Value(attentionUpdatedAt),
    );
  }

  factory CachedSession.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedSession(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      status: serializer.fromJson<String?>(json['status']),
      projectKey: serializer.fromJson<String?>(json['projectKey']),
      projectId: serializer.fromJson<String?>(json['projectId']),
      title: serializer.fromJson<String?>(json['title']),
      promptPreview: serializer.fromJson<String?>(json['promptPreview']),
      preview: serializer.fromJson<String?>(json['preview']),
      author: serializer.fromJson<String?>(json['author']),
      outcomeJson: serializer.fromJson<String?>(json['outcomeJson']),
      startedAt: serializer.fromJson<double?>(json['startedAt']),
      endedAt: serializer.fromJson<double?>(json['endedAt']),
      lastActivityAt: serializer.fromJson<double?>(json['lastActivityAt']),
      syncedAt: serializer.fromJson<double>(json['syncedAt']),
      attentionUnread: serializer.fromJson<bool>(json['attentionUnread']),
      attentionUpdatedAt: serializer.fromJson<double>(
        json['attentionUpdatedAt'],
      ),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'sessionId': serializer.toJson<String>(sessionId),
      'status': serializer.toJson<String?>(status),
      'projectKey': serializer.toJson<String?>(projectKey),
      'projectId': serializer.toJson<String?>(projectId),
      'title': serializer.toJson<String?>(title),
      'promptPreview': serializer.toJson<String?>(promptPreview),
      'preview': serializer.toJson<String?>(preview),
      'author': serializer.toJson<String?>(author),
      'outcomeJson': serializer.toJson<String?>(outcomeJson),
      'startedAt': serializer.toJson<double?>(startedAt),
      'endedAt': serializer.toJson<double?>(endedAt),
      'lastActivityAt': serializer.toJson<double?>(lastActivityAt),
      'syncedAt': serializer.toJson<double>(syncedAt),
      'attentionUnread': serializer.toJson<bool>(attentionUnread),
      'attentionUpdatedAt': serializer.toJson<double>(attentionUpdatedAt),
    };
  }

  CachedSession copyWith({
    String? workspaceId,
    String? peonId,
    String? sessionId,
    Value<String?> status = const Value.absent(),
    Value<String?> projectKey = const Value.absent(),
    Value<String?> projectId = const Value.absent(),
    Value<String?> title = const Value.absent(),
    Value<String?> promptPreview = const Value.absent(),
    Value<String?> preview = const Value.absent(),
    Value<String?> author = const Value.absent(),
    Value<String?> outcomeJson = const Value.absent(),
    Value<double?> startedAt = const Value.absent(),
    Value<double?> endedAt = const Value.absent(),
    Value<double?> lastActivityAt = const Value.absent(),
    double? syncedAt,
    bool? attentionUnread,
    double? attentionUpdatedAt,
  }) => CachedSession(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    sessionId: sessionId ?? this.sessionId,
    status: status.present ? status.value : this.status,
    projectKey: projectKey.present ? projectKey.value : this.projectKey,
    projectId: projectId.present ? projectId.value : this.projectId,
    title: title.present ? title.value : this.title,
    promptPreview: promptPreview.present
        ? promptPreview.value
        : this.promptPreview,
    preview: preview.present ? preview.value : this.preview,
    author: author.present ? author.value : this.author,
    outcomeJson: outcomeJson.present ? outcomeJson.value : this.outcomeJson,
    startedAt: startedAt.present ? startedAt.value : this.startedAt,
    endedAt: endedAt.present ? endedAt.value : this.endedAt,
    lastActivityAt: lastActivityAt.present
        ? lastActivityAt.value
        : this.lastActivityAt,
    syncedAt: syncedAt ?? this.syncedAt,
    attentionUnread: attentionUnread ?? this.attentionUnread,
    attentionUpdatedAt: attentionUpdatedAt ?? this.attentionUpdatedAt,
  );
  CachedSession copyWithCompanion(CachedSessionsCompanion data) {
    return CachedSession(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      status: data.status.present ? data.status.value : this.status,
      projectKey: data.projectKey.present
          ? data.projectKey.value
          : this.projectKey,
      projectId: data.projectId.present ? data.projectId.value : this.projectId,
      title: data.title.present ? data.title.value : this.title,
      promptPreview: data.promptPreview.present
          ? data.promptPreview.value
          : this.promptPreview,
      preview: data.preview.present ? data.preview.value : this.preview,
      author: data.author.present ? data.author.value : this.author,
      outcomeJson: data.outcomeJson.present
          ? data.outcomeJson.value
          : this.outcomeJson,
      startedAt: data.startedAt.present ? data.startedAt.value : this.startedAt,
      endedAt: data.endedAt.present ? data.endedAt.value : this.endedAt,
      lastActivityAt: data.lastActivityAt.present
          ? data.lastActivityAt.value
          : this.lastActivityAt,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
      attentionUnread: data.attentionUnread.present
          ? data.attentionUnread.value
          : this.attentionUnread,
      attentionUpdatedAt: data.attentionUpdatedAt.present
          ? data.attentionUpdatedAt.value
          : this.attentionUpdatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedSession(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('status: $status, ')
          ..write('projectKey: $projectKey, ')
          ..write('projectId: $projectId, ')
          ..write('title: $title, ')
          ..write('promptPreview: $promptPreview, ')
          ..write('preview: $preview, ')
          ..write('author: $author, ')
          ..write('outcomeJson: $outcomeJson, ')
          ..write('startedAt: $startedAt, ')
          ..write('endedAt: $endedAt, ')
          ..write('lastActivityAt: $lastActivityAt, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('attentionUnread: $attentionUnread, ')
          ..write('attentionUpdatedAt: $attentionUpdatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    workspaceId,
    peonId,
    sessionId,
    status,
    projectKey,
    projectId,
    title,
    promptPreview,
    preview,
    author,
    outcomeJson,
    startedAt,
    endedAt,
    lastActivityAt,
    syncedAt,
    attentionUnread,
    attentionUpdatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedSession &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.sessionId == this.sessionId &&
          other.status == this.status &&
          other.projectKey == this.projectKey &&
          other.projectId == this.projectId &&
          other.title == this.title &&
          other.promptPreview == this.promptPreview &&
          other.preview == this.preview &&
          other.author == this.author &&
          other.outcomeJson == this.outcomeJson &&
          other.startedAt == this.startedAt &&
          other.endedAt == this.endedAt &&
          other.lastActivityAt == this.lastActivityAt &&
          other.syncedAt == this.syncedAt &&
          other.attentionUnread == this.attentionUnread &&
          other.attentionUpdatedAt == this.attentionUpdatedAt);
}

class CachedSessionsCompanion extends UpdateCompanion<CachedSession> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> sessionId;
  final Value<String?> status;
  final Value<String?> projectKey;
  final Value<String?> projectId;
  final Value<String?> title;
  final Value<String?> promptPreview;
  final Value<String?> preview;
  final Value<String?> author;
  final Value<String?> outcomeJson;
  final Value<double?> startedAt;
  final Value<double?> endedAt;
  final Value<double?> lastActivityAt;
  final Value<double> syncedAt;
  final Value<bool> attentionUnread;
  final Value<double> attentionUpdatedAt;
  final Value<int> rowid;
  const CachedSessionsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.status = const Value.absent(),
    this.projectKey = const Value.absent(),
    this.projectId = const Value.absent(),
    this.title = const Value.absent(),
    this.promptPreview = const Value.absent(),
    this.preview = const Value.absent(),
    this.author = const Value.absent(),
    this.outcomeJson = const Value.absent(),
    this.startedAt = const Value.absent(),
    this.endedAt = const Value.absent(),
    this.lastActivityAt = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.attentionUnread = const Value.absent(),
    this.attentionUpdatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedSessionsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    this.status = const Value.absent(),
    this.projectKey = const Value.absent(),
    this.projectId = const Value.absent(),
    this.title = const Value.absent(),
    this.promptPreview = const Value.absent(),
    this.preview = const Value.absent(),
    this.author = const Value.absent(),
    this.outcomeJson = const Value.absent(),
    this.startedAt = const Value.absent(),
    this.endedAt = const Value.absent(),
    this.lastActivityAt = const Value.absent(),
    required double syncedAt,
    this.attentionUnread = const Value.absent(),
    this.attentionUpdatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       sessionId = Value(sessionId),
       syncedAt = Value(syncedAt);
  static Insertable<CachedSession> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? sessionId,
    Expression<String>? status,
    Expression<String>? projectKey,
    Expression<String>? projectId,
    Expression<String>? title,
    Expression<String>? promptPreview,
    Expression<String>? preview,
    Expression<String>? author,
    Expression<String>? outcomeJson,
    Expression<double>? startedAt,
    Expression<double>? endedAt,
    Expression<double>? lastActivityAt,
    Expression<double>? syncedAt,
    Expression<bool>? attentionUnread,
    Expression<double>? attentionUpdatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (sessionId != null) 'session_id': sessionId,
      if (status != null) 'status': status,
      if (projectKey != null) 'project_key': projectKey,
      if (projectId != null) 'project_id': projectId,
      if (title != null) 'title': title,
      if (promptPreview != null) 'prompt_preview': promptPreview,
      if (preview != null) 'preview': preview,
      if (author != null) 'author': author,
      if (outcomeJson != null) 'outcome_json': outcomeJson,
      if (startedAt != null) 'started_at': startedAt,
      if (endedAt != null) 'ended_at': endedAt,
      if (lastActivityAt != null) 'last_activity_at': lastActivityAt,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (attentionUnread != null) 'attention_unread': attentionUnread,
      if (attentionUpdatedAt != null)
        'attention_updated_at': attentionUpdatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedSessionsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? sessionId,
    Value<String?>? status,
    Value<String?>? projectKey,
    Value<String?>? projectId,
    Value<String?>? title,
    Value<String?>? promptPreview,
    Value<String?>? preview,
    Value<String?>? author,
    Value<String?>? outcomeJson,
    Value<double?>? startedAt,
    Value<double?>? endedAt,
    Value<double?>? lastActivityAt,
    Value<double>? syncedAt,
    Value<bool>? attentionUnread,
    Value<double>? attentionUpdatedAt,
    Value<int>? rowid,
  }) {
    return CachedSessionsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      sessionId: sessionId ?? this.sessionId,
      status: status ?? this.status,
      projectKey: projectKey ?? this.projectKey,
      projectId: projectId ?? this.projectId,
      title: title ?? this.title,
      promptPreview: promptPreview ?? this.promptPreview,
      preview: preview ?? this.preview,
      author: author ?? this.author,
      outcomeJson: outcomeJson ?? this.outcomeJson,
      startedAt: startedAt ?? this.startedAt,
      endedAt: endedAt ?? this.endedAt,
      lastActivityAt: lastActivityAt ?? this.lastActivityAt,
      syncedAt: syncedAt ?? this.syncedAt,
      attentionUnread: attentionUnread ?? this.attentionUnread,
      attentionUpdatedAt: attentionUpdatedAt ?? this.attentionUpdatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (status.present) {
      map['status'] = Variable<String>(status.value);
    }
    if (projectKey.present) {
      map['project_key'] = Variable<String>(projectKey.value);
    }
    if (projectId.present) {
      map['project_id'] = Variable<String>(projectId.value);
    }
    if (title.present) {
      map['title'] = Variable<String>(title.value);
    }
    if (promptPreview.present) {
      map['prompt_preview'] = Variable<String>(promptPreview.value);
    }
    if (preview.present) {
      map['preview'] = Variable<String>(preview.value);
    }
    if (author.present) {
      map['author'] = Variable<String>(author.value);
    }
    if (outcomeJson.present) {
      map['outcome_json'] = Variable<String>(outcomeJson.value);
    }
    if (startedAt.present) {
      map['started_at'] = Variable<double>(startedAt.value);
    }
    if (endedAt.present) {
      map['ended_at'] = Variable<double>(endedAt.value);
    }
    if (lastActivityAt.present) {
      map['last_activity_at'] = Variable<double>(lastActivityAt.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<double>(syncedAt.value);
    }
    if (attentionUnread.present) {
      map['attention_unread'] = Variable<bool>(attentionUnread.value);
    }
    if (attentionUpdatedAt.present) {
      map['attention_updated_at'] = Variable<double>(attentionUpdatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedSessionsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('status: $status, ')
          ..write('projectKey: $projectKey, ')
          ..write('projectId: $projectId, ')
          ..write('title: $title, ')
          ..write('promptPreview: $promptPreview, ')
          ..write('preview: $preview, ')
          ..write('author: $author, ')
          ..write('outcomeJson: $outcomeJson, ')
          ..write('startedAt: $startedAt, ')
          ..write('endedAt: $endedAt, ')
          ..write('lastActivityAt: $lastActivityAt, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('attentionUnread: $attentionUnread, ')
          ..write('attentionUpdatedAt: $attentionUpdatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedWorkspacesTable extends CachedWorkspaces
    with TableInfo<$CachedWorkspacesTable, CachedWorkspace> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedWorkspacesTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _roleMeta = const VerificationMeta('role');
  @override
  late final GeneratedColumn<String> role = GeneratedColumn<String>(
    'role',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<double> syncedAt = GeneratedColumn<double>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [workspaceId, name, role, syncedAt];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_workspaces';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedWorkspace> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    } else if (isInserting) {
      context.missing(_nameMeta);
    }
    if (data.containsKey('role')) {
      context.handle(
        _roleMeta,
        role.isAcceptableOrUnknown(data['role']!, _roleMeta),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_syncedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId};
  @override
  CachedWorkspace map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedWorkspace(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      )!,
      role: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}role'],
      ),
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}synced_at'],
      )!,
    );
  }

  @override
  $CachedWorkspacesTable createAlias(String alias) {
    return $CachedWorkspacesTable(attachedDatabase, alias);
  }
}

class CachedWorkspace extends DataClass implements Insertable<CachedWorkspace> {
  final String workspaceId;
  final String name;
  final String? role;
  final double syncedAt;
  const CachedWorkspace({
    required this.workspaceId,
    required this.name,
    this.role,
    required this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['name'] = Variable<String>(name);
    if (!nullToAbsent || role != null) {
      map['role'] = Variable<String>(role);
    }
    map['synced_at'] = Variable<double>(syncedAt);
    return map;
  }

  CachedWorkspacesCompanion toCompanion(bool nullToAbsent) {
    return CachedWorkspacesCompanion(
      workspaceId: Value(workspaceId),
      name: Value(name),
      role: role == null && nullToAbsent ? const Value.absent() : Value(role),
      syncedAt: Value(syncedAt),
    );
  }

  factory CachedWorkspace.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedWorkspace(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      name: serializer.fromJson<String>(json['name']),
      role: serializer.fromJson<String?>(json['role']),
      syncedAt: serializer.fromJson<double>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'name': serializer.toJson<String>(name),
      'role': serializer.toJson<String?>(role),
      'syncedAt': serializer.toJson<double>(syncedAt),
    };
  }

  CachedWorkspace copyWith({
    String? workspaceId,
    String? name,
    Value<String?> role = const Value.absent(),
    double? syncedAt,
  }) => CachedWorkspace(
    workspaceId: workspaceId ?? this.workspaceId,
    name: name ?? this.name,
    role: role.present ? role.value : this.role,
    syncedAt: syncedAt ?? this.syncedAt,
  );
  CachedWorkspace copyWithCompanion(CachedWorkspacesCompanion data) {
    return CachedWorkspace(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      name: data.name.present ? data.name.value : this.name,
      role: data.role.present ? data.role.value : this.role,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedWorkspace(')
          ..write('workspaceId: $workspaceId, ')
          ..write('name: $name, ')
          ..write('role: $role, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(workspaceId, name, role, syncedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedWorkspace &&
          other.workspaceId == this.workspaceId &&
          other.name == this.name &&
          other.role == this.role &&
          other.syncedAt == this.syncedAt);
}

class CachedWorkspacesCompanion extends UpdateCompanion<CachedWorkspace> {
  final Value<String> workspaceId;
  final Value<String> name;
  final Value<String?> role;
  final Value<double> syncedAt;
  final Value<int> rowid;
  const CachedWorkspacesCompanion({
    this.workspaceId = const Value.absent(),
    this.name = const Value.absent(),
    this.role = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedWorkspacesCompanion.insert({
    required String workspaceId,
    required String name,
    this.role = const Value.absent(),
    required double syncedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       name = Value(name),
       syncedAt = Value(syncedAt);
  static Insertable<CachedWorkspace> custom({
    Expression<String>? workspaceId,
    Expression<String>? name,
    Expression<String>? role,
    Expression<double>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (name != null) 'name': name,
      if (role != null) 'role': role,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedWorkspacesCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? name,
    Value<String?>? role,
    Value<double>? syncedAt,
    Value<int>? rowid,
  }) {
    return CachedWorkspacesCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      name: name ?? this.name,
      role: role ?? this.role,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (role.present) {
      map['role'] = Variable<String>(role.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<double>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedWorkspacesCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('name: $name, ')
          ..write('role: $role, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedFleetPeonsTable extends CachedFleetPeons
    with TableInfo<$CachedFleetPeonsTable, CachedFleetPeon> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedFleetPeonsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _hostnameMeta = const VerificationMeta(
    'hostname',
  );
  @override
  late final GeneratedColumn<String> hostname = GeneratedColumn<String>(
    'hostname',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _baseUrlMeta = const VerificationMeta(
    'baseUrl',
  );
  @override
  late final GeneratedColumn<String> baseUrl = GeneratedColumn<String>(
    'base_url',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _addressSourceMeta = const VerificationMeta(
    'addressSource',
  );
  @override
  late final GeneratedColumn<String> addressSource = GeneratedColumn<String>(
    'address_source',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _onlineMeta = const VerificationMeta('online');
  @override
  late final GeneratedColumn<bool> online = GeneratedColumn<bool>(
    'online',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("online" IN (0, 1))',
    ),
  );
  static const VerificationMeta _lastSeenMeta = const VerificationMeta(
    'lastSeen',
  );
  @override
  late final GeneratedColumn<double> lastSeen = GeneratedColumn<double>(
    'last_seen',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _capabilitiesJsonMeta = const VerificationMeta(
    'capabilitiesJson',
  );
  @override
  late final GeneratedColumn<String> capabilitiesJson = GeneratedColumn<String>(
    'capabilities_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _activeSessionsMeta = const VerificationMeta(
    'activeSessions',
  );
  @override
  late final GeneratedColumn<int> activeSessions = GeneratedColumn<int>(
    'active_sessions',
    aliasedName,
    true,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _pausedMeta = const VerificationMeta('paused');
  @override
  late final GeneratedColumn<bool> paused = GeneratedColumn<bool>(
    'paused',
    aliasedName,
    true,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("paused" IN (0, 1))',
    ),
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<double> syncedAt = GeneratedColumn<double>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    name,
    hostname,
    baseUrl,
    addressSource,
    online,
    lastSeen,
    capabilitiesJson,
    activeSessions,
    paused,
    syncedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_fleet_peons';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedFleetPeon> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    }
    if (data.containsKey('hostname')) {
      context.handle(
        _hostnameMeta,
        hostname.isAcceptableOrUnknown(data['hostname']!, _hostnameMeta),
      );
    }
    if (data.containsKey('base_url')) {
      context.handle(
        _baseUrlMeta,
        baseUrl.isAcceptableOrUnknown(data['base_url']!, _baseUrlMeta),
      );
    }
    if (data.containsKey('address_source')) {
      context.handle(
        _addressSourceMeta,
        addressSource.isAcceptableOrUnknown(
          data['address_source']!,
          _addressSourceMeta,
        ),
      );
    }
    if (data.containsKey('online')) {
      context.handle(
        _onlineMeta,
        online.isAcceptableOrUnknown(data['online']!, _onlineMeta),
      );
    } else if (isInserting) {
      context.missing(_onlineMeta);
    }
    if (data.containsKey('last_seen')) {
      context.handle(
        _lastSeenMeta,
        lastSeen.isAcceptableOrUnknown(data['last_seen']!, _lastSeenMeta),
      );
    } else if (isInserting) {
      context.missing(_lastSeenMeta);
    }
    if (data.containsKey('capabilities_json')) {
      context.handle(
        _capabilitiesJsonMeta,
        capabilitiesJson.isAcceptableOrUnknown(
          data['capabilities_json']!,
          _capabilitiesJsonMeta,
        ),
      );
    }
    if (data.containsKey('active_sessions')) {
      context.handle(
        _activeSessionsMeta,
        activeSessions.isAcceptableOrUnknown(
          data['active_sessions']!,
          _activeSessionsMeta,
        ),
      );
    }
    if (data.containsKey('paused')) {
      context.handle(
        _pausedMeta,
        paused.isAcceptableOrUnknown(data['paused']!, _pausedMeta),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_syncedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId};
  @override
  CachedFleetPeon map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedFleetPeon(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      ),
      hostname: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}hostname'],
      ),
      baseUrl: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}base_url'],
      ),
      addressSource: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}address_source'],
      ),
      online: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}online'],
      )!,
      lastSeen: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}last_seen'],
      )!,
      capabilitiesJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}capabilities_json'],
      )!,
      activeSessions: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}active_sessions'],
      ),
      paused: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}paused'],
      ),
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}synced_at'],
      )!,
    );
  }

  @override
  $CachedFleetPeonsTable createAlias(String alias) {
    return $CachedFleetPeonsTable(attachedDatabase, alias);
  }
}

class CachedFleetPeon extends DataClass implements Insertable<CachedFleetPeon> {
  final String workspaceId;
  final String peonId;
  final String? name;
  final String? hostname;
  final String? baseUrl;
  final String? addressSource;
  final bool online;
  final double lastSeen;
  final String capabilitiesJson;
  final int? activeSessions;
  final bool? paused;
  final double syncedAt;
  const CachedFleetPeon({
    required this.workspaceId,
    required this.peonId,
    this.name,
    this.hostname,
    this.baseUrl,
    this.addressSource,
    required this.online,
    required this.lastSeen,
    required this.capabilitiesJson,
    this.activeSessions,
    this.paused,
    required this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    if (!nullToAbsent || name != null) {
      map['name'] = Variable<String>(name);
    }
    if (!nullToAbsent || hostname != null) {
      map['hostname'] = Variable<String>(hostname);
    }
    if (!nullToAbsent || baseUrl != null) {
      map['base_url'] = Variable<String>(baseUrl);
    }
    if (!nullToAbsent || addressSource != null) {
      map['address_source'] = Variable<String>(addressSource);
    }
    map['online'] = Variable<bool>(online);
    map['last_seen'] = Variable<double>(lastSeen);
    map['capabilities_json'] = Variable<String>(capabilitiesJson);
    if (!nullToAbsent || activeSessions != null) {
      map['active_sessions'] = Variable<int>(activeSessions);
    }
    if (!nullToAbsent || paused != null) {
      map['paused'] = Variable<bool>(paused);
    }
    map['synced_at'] = Variable<double>(syncedAt);
    return map;
  }

  CachedFleetPeonsCompanion toCompanion(bool nullToAbsent) {
    return CachedFleetPeonsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      name: name == null && nullToAbsent ? const Value.absent() : Value(name),
      hostname: hostname == null && nullToAbsent
          ? const Value.absent()
          : Value(hostname),
      baseUrl: baseUrl == null && nullToAbsent
          ? const Value.absent()
          : Value(baseUrl),
      addressSource: addressSource == null && nullToAbsent
          ? const Value.absent()
          : Value(addressSource),
      online: Value(online),
      lastSeen: Value(lastSeen),
      capabilitiesJson: Value(capabilitiesJson),
      activeSessions: activeSessions == null && nullToAbsent
          ? const Value.absent()
          : Value(activeSessions),
      paused: paused == null && nullToAbsent
          ? const Value.absent()
          : Value(paused),
      syncedAt: Value(syncedAt),
    );
  }

  factory CachedFleetPeon.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedFleetPeon(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      name: serializer.fromJson<String?>(json['name']),
      hostname: serializer.fromJson<String?>(json['hostname']),
      baseUrl: serializer.fromJson<String?>(json['baseUrl']),
      addressSource: serializer.fromJson<String?>(json['addressSource']),
      online: serializer.fromJson<bool>(json['online']),
      lastSeen: serializer.fromJson<double>(json['lastSeen']),
      capabilitiesJson: serializer.fromJson<String>(json['capabilitiesJson']),
      activeSessions: serializer.fromJson<int?>(json['activeSessions']),
      paused: serializer.fromJson<bool?>(json['paused']),
      syncedAt: serializer.fromJson<double>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'name': serializer.toJson<String?>(name),
      'hostname': serializer.toJson<String?>(hostname),
      'baseUrl': serializer.toJson<String?>(baseUrl),
      'addressSource': serializer.toJson<String?>(addressSource),
      'online': serializer.toJson<bool>(online),
      'lastSeen': serializer.toJson<double>(lastSeen),
      'capabilitiesJson': serializer.toJson<String>(capabilitiesJson),
      'activeSessions': serializer.toJson<int?>(activeSessions),
      'paused': serializer.toJson<bool?>(paused),
      'syncedAt': serializer.toJson<double>(syncedAt),
    };
  }

  CachedFleetPeon copyWith({
    String? workspaceId,
    String? peonId,
    Value<String?> name = const Value.absent(),
    Value<String?> hostname = const Value.absent(),
    Value<String?> baseUrl = const Value.absent(),
    Value<String?> addressSource = const Value.absent(),
    bool? online,
    double? lastSeen,
    String? capabilitiesJson,
    Value<int?> activeSessions = const Value.absent(),
    Value<bool?> paused = const Value.absent(),
    double? syncedAt,
  }) => CachedFleetPeon(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    name: name.present ? name.value : this.name,
    hostname: hostname.present ? hostname.value : this.hostname,
    baseUrl: baseUrl.present ? baseUrl.value : this.baseUrl,
    addressSource: addressSource.present
        ? addressSource.value
        : this.addressSource,
    online: online ?? this.online,
    lastSeen: lastSeen ?? this.lastSeen,
    capabilitiesJson: capabilitiesJson ?? this.capabilitiesJson,
    activeSessions: activeSessions.present
        ? activeSessions.value
        : this.activeSessions,
    paused: paused.present ? paused.value : this.paused,
    syncedAt: syncedAt ?? this.syncedAt,
  );
  CachedFleetPeon copyWithCompanion(CachedFleetPeonsCompanion data) {
    return CachedFleetPeon(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      name: data.name.present ? data.name.value : this.name,
      hostname: data.hostname.present ? data.hostname.value : this.hostname,
      baseUrl: data.baseUrl.present ? data.baseUrl.value : this.baseUrl,
      addressSource: data.addressSource.present
          ? data.addressSource.value
          : this.addressSource,
      online: data.online.present ? data.online.value : this.online,
      lastSeen: data.lastSeen.present ? data.lastSeen.value : this.lastSeen,
      capabilitiesJson: data.capabilitiesJson.present
          ? data.capabilitiesJson.value
          : this.capabilitiesJson,
      activeSessions: data.activeSessions.present
          ? data.activeSessions.value
          : this.activeSessions,
      paused: data.paused.present ? data.paused.value : this.paused,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedFleetPeon(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('name: $name, ')
          ..write('hostname: $hostname, ')
          ..write('baseUrl: $baseUrl, ')
          ..write('addressSource: $addressSource, ')
          ..write('online: $online, ')
          ..write('lastSeen: $lastSeen, ')
          ..write('capabilitiesJson: $capabilitiesJson, ')
          ..write('activeSessions: $activeSessions, ')
          ..write('paused: $paused, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    workspaceId,
    peonId,
    name,
    hostname,
    baseUrl,
    addressSource,
    online,
    lastSeen,
    capabilitiesJson,
    activeSessions,
    paused,
    syncedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedFleetPeon &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.name == this.name &&
          other.hostname == this.hostname &&
          other.baseUrl == this.baseUrl &&
          other.addressSource == this.addressSource &&
          other.online == this.online &&
          other.lastSeen == this.lastSeen &&
          other.capabilitiesJson == this.capabilitiesJson &&
          other.activeSessions == this.activeSessions &&
          other.paused == this.paused &&
          other.syncedAt == this.syncedAt);
}

class CachedFleetPeonsCompanion extends UpdateCompanion<CachedFleetPeon> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String?> name;
  final Value<String?> hostname;
  final Value<String?> baseUrl;
  final Value<String?> addressSource;
  final Value<bool> online;
  final Value<double> lastSeen;
  final Value<String> capabilitiesJson;
  final Value<int?> activeSessions;
  final Value<bool?> paused;
  final Value<double> syncedAt;
  final Value<int> rowid;
  const CachedFleetPeonsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.name = const Value.absent(),
    this.hostname = const Value.absent(),
    this.baseUrl = const Value.absent(),
    this.addressSource = const Value.absent(),
    this.online = const Value.absent(),
    this.lastSeen = const Value.absent(),
    this.capabilitiesJson = const Value.absent(),
    this.activeSessions = const Value.absent(),
    this.paused = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedFleetPeonsCompanion.insert({
    required String workspaceId,
    required String peonId,
    this.name = const Value.absent(),
    this.hostname = const Value.absent(),
    this.baseUrl = const Value.absent(),
    this.addressSource = const Value.absent(),
    required bool online,
    required double lastSeen,
    this.capabilitiesJson = const Value.absent(),
    this.activeSessions = const Value.absent(),
    this.paused = const Value.absent(),
    required double syncedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       online = Value(online),
       lastSeen = Value(lastSeen),
       syncedAt = Value(syncedAt);
  static Insertable<CachedFleetPeon> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? name,
    Expression<String>? hostname,
    Expression<String>? baseUrl,
    Expression<String>? addressSource,
    Expression<bool>? online,
    Expression<double>? lastSeen,
    Expression<String>? capabilitiesJson,
    Expression<int>? activeSessions,
    Expression<bool>? paused,
    Expression<double>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (name != null) 'name': name,
      if (hostname != null) 'hostname': hostname,
      if (baseUrl != null) 'base_url': baseUrl,
      if (addressSource != null) 'address_source': addressSource,
      if (online != null) 'online': online,
      if (lastSeen != null) 'last_seen': lastSeen,
      if (capabilitiesJson != null) 'capabilities_json': capabilitiesJson,
      if (activeSessions != null) 'active_sessions': activeSessions,
      if (paused != null) 'paused': paused,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedFleetPeonsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String?>? name,
    Value<String?>? hostname,
    Value<String?>? baseUrl,
    Value<String?>? addressSource,
    Value<bool>? online,
    Value<double>? lastSeen,
    Value<String>? capabilitiesJson,
    Value<int?>? activeSessions,
    Value<bool?>? paused,
    Value<double>? syncedAt,
    Value<int>? rowid,
  }) {
    return CachedFleetPeonsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      name: name ?? this.name,
      hostname: hostname ?? this.hostname,
      baseUrl: baseUrl ?? this.baseUrl,
      addressSource: addressSource ?? this.addressSource,
      online: online ?? this.online,
      lastSeen: lastSeen ?? this.lastSeen,
      capabilitiesJson: capabilitiesJson ?? this.capabilitiesJson,
      activeSessions: activeSessions ?? this.activeSessions,
      paused: paused ?? this.paused,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (hostname.present) {
      map['hostname'] = Variable<String>(hostname.value);
    }
    if (baseUrl.present) {
      map['base_url'] = Variable<String>(baseUrl.value);
    }
    if (addressSource.present) {
      map['address_source'] = Variable<String>(addressSource.value);
    }
    if (online.present) {
      map['online'] = Variable<bool>(online.value);
    }
    if (lastSeen.present) {
      map['last_seen'] = Variable<double>(lastSeen.value);
    }
    if (capabilitiesJson.present) {
      map['capabilities_json'] = Variable<String>(capabilitiesJson.value);
    }
    if (activeSessions.present) {
      map['active_sessions'] = Variable<int>(activeSessions.value);
    }
    if (paused.present) {
      map['paused'] = Variable<bool>(paused.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<double>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedFleetPeonsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('name: $name, ')
          ..write('hostname: $hostname, ')
          ..write('baseUrl: $baseUrl, ')
          ..write('addressSource: $addressSource, ')
          ..write('online: $online, ')
          ..write('lastSeen: $lastSeen, ')
          ..write('capabilitiesJson: $capabilitiesJson, ')
          ..write('activeSessions: $activeSessions, ')
          ..write('paused: $paused, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedProjectsTable extends CachedProjects
    with TableInfo<$CachedProjectsTable, CachedProject> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedProjectsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _projectIdMeta = const VerificationMeta(
    'projectId',
  );
  @override
  late final GeneratedColumn<String> projectId = GeneratedColumn<String>(
    'project_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _projectKeyMeta = const VerificationMeta(
    'projectKey',
  );
  @override
  late final GeneratedColumn<String> projectKey = GeneratedColumn<String>(
    'project_key',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _nameMeta = const VerificationMeta('name');
  @override
  late final GeneratedColumn<String> name = GeneratedColumn<String>(
    'name',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _dirMeta = const VerificationMeta('dir');
  @override
  late final GeneratedColumn<String> dir = GeneratedColumn<String>(
    'dir',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _metadataMeta = const VerificationMeta(
    'metadata',
  );
  @override
  late final GeneratedColumn<String> metadata = GeneratedColumn<String>(
    'metadata',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _sessionCountMeta = const VerificationMeta(
    'sessionCount',
  );
  @override
  late final GeneratedColumn<int> sessionCount = GeneratedColumn<int>(
    'session_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _memberCountMeta = const VerificationMeta(
    'memberCount',
  );
  @override
  late final GeneratedColumn<int> memberCount = GeneratedColumn<int>(
    'member_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _activeCountMeta = const VerificationMeta(
    'activeCount',
  );
  @override
  late final GeneratedColumn<int> activeCount = GeneratedColumn<int>(
    'active_count',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _lastActivityMsMeta = const VerificationMeta(
    'lastActivityMs',
  );
  @override
  late final GeneratedColumn<double> lastActivityMs = GeneratedColumn<double>(
    'last_activity_ms',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<double> syncedAt = GeneratedColumn<double>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  static const VerificationMeta _deletedMeta = const VerificationMeta(
    'deleted',
  );
  @override
  late final GeneratedColumn<bool> deleted = GeneratedColumn<bool>(
    'deleted',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("deleted" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    projectId,
    projectKey,
    name,
    dir,
    metadata,
    sessionCount,
    memberCount,
    activeCount,
    lastActivityMs,
    syncedAt,
    deleted,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_projects';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedProject> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('project_id')) {
      context.handle(
        _projectIdMeta,
        projectId.isAcceptableOrUnknown(data['project_id']!, _projectIdMeta),
      );
    } else if (isInserting) {
      context.missing(_projectIdMeta);
    }
    if (data.containsKey('project_key')) {
      context.handle(
        _projectKeyMeta,
        projectKey.isAcceptableOrUnknown(data['project_key']!, _projectKeyMeta),
      );
    } else if (isInserting) {
      context.missing(_projectKeyMeta);
    }
    if (data.containsKey('name')) {
      context.handle(
        _nameMeta,
        name.isAcceptableOrUnknown(data['name']!, _nameMeta),
      );
    }
    if (data.containsKey('dir')) {
      context.handle(
        _dirMeta,
        dir.isAcceptableOrUnknown(data['dir']!, _dirMeta),
      );
    }
    if (data.containsKey('metadata')) {
      context.handle(
        _metadataMeta,
        metadata.isAcceptableOrUnknown(data['metadata']!, _metadataMeta),
      );
    }
    if (data.containsKey('session_count')) {
      context.handle(
        _sessionCountMeta,
        sessionCount.isAcceptableOrUnknown(
          data['session_count']!,
          _sessionCountMeta,
        ),
      );
    }
    if (data.containsKey('member_count')) {
      context.handle(
        _memberCountMeta,
        memberCount.isAcceptableOrUnknown(
          data['member_count']!,
          _memberCountMeta,
        ),
      );
    }
    if (data.containsKey('active_count')) {
      context.handle(
        _activeCountMeta,
        activeCount.isAcceptableOrUnknown(
          data['active_count']!,
          _activeCountMeta,
        ),
      );
    }
    if (data.containsKey('last_activity_ms')) {
      context.handle(
        _lastActivityMsMeta,
        lastActivityMs.isAcceptableOrUnknown(
          data['last_activity_ms']!,
          _lastActivityMsMeta,
        ),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    }
    if (data.containsKey('deleted')) {
      context.handle(
        _deletedMeta,
        deleted.isAcceptableOrUnknown(data['deleted']!, _deletedMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId, projectId};
  @override
  CachedProject map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedProject(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      projectId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}project_id'],
      )!,
      projectKey: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}project_key'],
      )!,
      name: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}name'],
      ),
      dir: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}dir'],
      ),
      metadata: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}metadata'],
      ),
      sessionCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}session_count'],
      )!,
      memberCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}member_count'],
      )!,
      activeCount: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}active_count'],
      )!,
      lastActivityMs: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}last_activity_ms'],
      ),
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}synced_at'],
      )!,
      deleted: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}deleted'],
      )!,
    );
  }

  @override
  $CachedProjectsTable createAlias(String alias) {
    return $CachedProjectsTable(attachedDatabase, alias);
  }
}

class CachedProject extends DataClass implements Insertable<CachedProject> {
  final String workspaceId;
  final String peonId;
  final String projectId;
  final String projectKey;
  final String? name;
  final String? dir;
  final String? metadata;
  final int sessionCount;
  final int memberCount;
  final int activeCount;
  final double? lastActivityMs;
  final double syncedAt;
  final bool deleted;
  const CachedProject({
    required this.workspaceId,
    required this.peonId,
    required this.projectId,
    required this.projectKey,
    this.name,
    this.dir,
    this.metadata,
    required this.sessionCount,
    required this.memberCount,
    required this.activeCount,
    this.lastActivityMs,
    required this.syncedAt,
    required this.deleted,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['project_id'] = Variable<String>(projectId);
    map['project_key'] = Variable<String>(projectKey);
    if (!nullToAbsent || name != null) {
      map['name'] = Variable<String>(name);
    }
    if (!nullToAbsent || dir != null) {
      map['dir'] = Variable<String>(dir);
    }
    if (!nullToAbsent || metadata != null) {
      map['metadata'] = Variable<String>(metadata);
    }
    map['session_count'] = Variable<int>(sessionCount);
    map['member_count'] = Variable<int>(memberCount);
    map['active_count'] = Variable<int>(activeCount);
    if (!nullToAbsent || lastActivityMs != null) {
      map['last_activity_ms'] = Variable<double>(lastActivityMs);
    }
    map['synced_at'] = Variable<double>(syncedAt);
    map['deleted'] = Variable<bool>(deleted);
    return map;
  }

  CachedProjectsCompanion toCompanion(bool nullToAbsent) {
    return CachedProjectsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      projectId: Value(projectId),
      projectKey: Value(projectKey),
      name: name == null && nullToAbsent ? const Value.absent() : Value(name),
      dir: dir == null && nullToAbsent ? const Value.absent() : Value(dir),
      metadata: metadata == null && nullToAbsent
          ? const Value.absent()
          : Value(metadata),
      sessionCount: Value(sessionCount),
      memberCount: Value(memberCount),
      activeCount: Value(activeCount),
      lastActivityMs: lastActivityMs == null && nullToAbsent
          ? const Value.absent()
          : Value(lastActivityMs),
      syncedAt: Value(syncedAt),
      deleted: Value(deleted),
    );
  }

  factory CachedProject.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedProject(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      projectId: serializer.fromJson<String>(json['projectId']),
      projectKey: serializer.fromJson<String>(json['projectKey']),
      name: serializer.fromJson<String?>(json['name']),
      dir: serializer.fromJson<String?>(json['dir']),
      metadata: serializer.fromJson<String?>(json['metadata']),
      sessionCount: serializer.fromJson<int>(json['sessionCount']),
      memberCount: serializer.fromJson<int>(json['memberCount']),
      activeCount: serializer.fromJson<int>(json['activeCount']),
      lastActivityMs: serializer.fromJson<double?>(json['lastActivityMs']),
      syncedAt: serializer.fromJson<double>(json['syncedAt']),
      deleted: serializer.fromJson<bool>(json['deleted']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'projectId': serializer.toJson<String>(projectId),
      'projectKey': serializer.toJson<String>(projectKey),
      'name': serializer.toJson<String?>(name),
      'dir': serializer.toJson<String?>(dir),
      'metadata': serializer.toJson<String?>(metadata),
      'sessionCount': serializer.toJson<int>(sessionCount),
      'memberCount': serializer.toJson<int>(memberCount),
      'activeCount': serializer.toJson<int>(activeCount),
      'lastActivityMs': serializer.toJson<double?>(lastActivityMs),
      'syncedAt': serializer.toJson<double>(syncedAt),
      'deleted': serializer.toJson<bool>(deleted),
    };
  }

  CachedProject copyWith({
    String? workspaceId,
    String? peonId,
    String? projectId,
    String? projectKey,
    Value<String?> name = const Value.absent(),
    Value<String?> dir = const Value.absent(),
    Value<String?> metadata = const Value.absent(),
    int? sessionCount,
    int? memberCount,
    int? activeCount,
    Value<double?> lastActivityMs = const Value.absent(),
    double? syncedAt,
    bool? deleted,
  }) => CachedProject(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    projectId: projectId ?? this.projectId,
    projectKey: projectKey ?? this.projectKey,
    name: name.present ? name.value : this.name,
    dir: dir.present ? dir.value : this.dir,
    metadata: metadata.present ? metadata.value : this.metadata,
    sessionCount: sessionCount ?? this.sessionCount,
    memberCount: memberCount ?? this.memberCount,
    activeCount: activeCount ?? this.activeCount,
    lastActivityMs: lastActivityMs.present
        ? lastActivityMs.value
        : this.lastActivityMs,
    syncedAt: syncedAt ?? this.syncedAt,
    deleted: deleted ?? this.deleted,
  );
  CachedProject copyWithCompanion(CachedProjectsCompanion data) {
    return CachedProject(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      projectId: data.projectId.present ? data.projectId.value : this.projectId,
      projectKey: data.projectKey.present
          ? data.projectKey.value
          : this.projectKey,
      name: data.name.present ? data.name.value : this.name,
      dir: data.dir.present ? data.dir.value : this.dir,
      metadata: data.metadata.present ? data.metadata.value : this.metadata,
      sessionCount: data.sessionCount.present
          ? data.sessionCount.value
          : this.sessionCount,
      memberCount: data.memberCount.present
          ? data.memberCount.value
          : this.memberCount,
      activeCount: data.activeCount.present
          ? data.activeCount.value
          : this.activeCount,
      lastActivityMs: data.lastActivityMs.present
          ? data.lastActivityMs.value
          : this.lastActivityMs,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
      deleted: data.deleted.present ? data.deleted.value : this.deleted,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedProject(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('projectId: $projectId, ')
          ..write('projectKey: $projectKey, ')
          ..write('name: $name, ')
          ..write('dir: $dir, ')
          ..write('metadata: $metadata, ')
          ..write('sessionCount: $sessionCount, ')
          ..write('memberCount: $memberCount, ')
          ..write('activeCount: $activeCount, ')
          ..write('lastActivityMs: $lastActivityMs, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('deleted: $deleted')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    workspaceId,
    peonId,
    projectId,
    projectKey,
    name,
    dir,
    metadata,
    sessionCount,
    memberCount,
    activeCount,
    lastActivityMs,
    syncedAt,
    deleted,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedProject &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.projectId == this.projectId &&
          other.projectKey == this.projectKey &&
          other.name == this.name &&
          other.dir == this.dir &&
          other.metadata == this.metadata &&
          other.sessionCount == this.sessionCount &&
          other.memberCount == this.memberCount &&
          other.activeCount == this.activeCount &&
          other.lastActivityMs == this.lastActivityMs &&
          other.syncedAt == this.syncedAt &&
          other.deleted == this.deleted);
}

class CachedProjectsCompanion extends UpdateCompanion<CachedProject> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> projectId;
  final Value<String> projectKey;
  final Value<String?> name;
  final Value<String?> dir;
  final Value<String?> metadata;
  final Value<int> sessionCount;
  final Value<int> memberCount;
  final Value<int> activeCount;
  final Value<double?> lastActivityMs;
  final Value<double> syncedAt;
  final Value<bool> deleted;
  final Value<int> rowid;
  const CachedProjectsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.projectId = const Value.absent(),
    this.projectKey = const Value.absent(),
    this.name = const Value.absent(),
    this.dir = const Value.absent(),
    this.metadata = const Value.absent(),
    this.sessionCount = const Value.absent(),
    this.memberCount = const Value.absent(),
    this.activeCount = const Value.absent(),
    this.lastActivityMs = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.deleted = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedProjectsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String projectId,
    required String projectKey,
    this.name = const Value.absent(),
    this.dir = const Value.absent(),
    this.metadata = const Value.absent(),
    this.sessionCount = const Value.absent(),
    this.memberCount = const Value.absent(),
    this.activeCount = const Value.absent(),
    this.lastActivityMs = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.deleted = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       projectId = Value(projectId),
       projectKey = Value(projectKey);
  static Insertable<CachedProject> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? projectId,
    Expression<String>? projectKey,
    Expression<String>? name,
    Expression<String>? dir,
    Expression<String>? metadata,
    Expression<int>? sessionCount,
    Expression<int>? memberCount,
    Expression<int>? activeCount,
    Expression<double>? lastActivityMs,
    Expression<double>? syncedAt,
    Expression<bool>? deleted,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (projectId != null) 'project_id': projectId,
      if (projectKey != null) 'project_key': projectKey,
      if (name != null) 'name': name,
      if (dir != null) 'dir': dir,
      if (metadata != null) 'metadata': metadata,
      if (sessionCount != null) 'session_count': sessionCount,
      if (memberCount != null) 'member_count': memberCount,
      if (activeCount != null) 'active_count': activeCount,
      if (lastActivityMs != null) 'last_activity_ms': lastActivityMs,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (deleted != null) 'deleted': deleted,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedProjectsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? projectId,
    Value<String>? projectKey,
    Value<String?>? name,
    Value<String?>? dir,
    Value<String?>? metadata,
    Value<int>? sessionCount,
    Value<int>? memberCount,
    Value<int>? activeCount,
    Value<double?>? lastActivityMs,
    Value<double>? syncedAt,
    Value<bool>? deleted,
    Value<int>? rowid,
  }) {
    return CachedProjectsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      projectId: projectId ?? this.projectId,
      projectKey: projectKey ?? this.projectKey,
      name: name ?? this.name,
      dir: dir ?? this.dir,
      metadata: metadata ?? this.metadata,
      sessionCount: sessionCount ?? this.sessionCount,
      memberCount: memberCount ?? this.memberCount,
      activeCount: activeCount ?? this.activeCount,
      lastActivityMs: lastActivityMs ?? this.lastActivityMs,
      syncedAt: syncedAt ?? this.syncedAt,
      deleted: deleted ?? this.deleted,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (projectId.present) {
      map['project_id'] = Variable<String>(projectId.value);
    }
    if (projectKey.present) {
      map['project_key'] = Variable<String>(projectKey.value);
    }
    if (name.present) {
      map['name'] = Variable<String>(name.value);
    }
    if (dir.present) {
      map['dir'] = Variable<String>(dir.value);
    }
    if (metadata.present) {
      map['metadata'] = Variable<String>(metadata.value);
    }
    if (sessionCount.present) {
      map['session_count'] = Variable<int>(sessionCount.value);
    }
    if (memberCount.present) {
      map['member_count'] = Variable<int>(memberCount.value);
    }
    if (activeCount.present) {
      map['active_count'] = Variable<int>(activeCount.value);
    }
    if (lastActivityMs.present) {
      map['last_activity_ms'] = Variable<double>(lastActivityMs.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<double>(syncedAt.value);
    }
    if (deleted.present) {
      map['deleted'] = Variable<bool>(deleted.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedProjectsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('projectId: $projectId, ')
          ..write('projectKey: $projectKey, ')
          ..write('name: $name, ')
          ..write('dir: $dir, ')
          ..write('metadata: $metadata, ')
          ..write('sessionCount: $sessionCount, ')
          ..write('memberCount: $memberCount, ')
          ..write('activeCount: $activeCount, ')
          ..write('lastActivityMs: $lastActivityMs, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('deleted: $deleted, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedAiStatsTable extends CachedAiStats
    with TableInfo<$CachedAiStatsTable, CachedAiStat> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedAiStatsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _periodMeta = const VerificationMeta('period');
  @override
  late final GeneratedColumn<String> period = GeneratedColumn<String>(
    'period',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadJsonMeta = const VerificationMeta(
    'payloadJson',
  );
  @override
  late final GeneratedColumn<String> payloadJson = GeneratedColumn<String>(
    'payload_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<double> updatedAt = GeneratedColumn<double>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    period,
    payloadJson,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_ai_stats';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedAiStat> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('period')) {
      context.handle(
        _periodMeta,
        period.isAcceptableOrUnknown(data['period']!, _periodMeta),
      );
    } else if (isInserting) {
      context.missing(_periodMeta);
    }
    if (data.containsKey('payload_json')) {
      context.handle(
        _payloadJsonMeta,
        payloadJson.isAcceptableOrUnknown(
          data['payload_json']!,
          _payloadJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadJsonMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId, period};
  @override
  CachedAiStat map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedAiStat(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      period: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}period'],
      )!,
      payloadJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload_json'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $CachedAiStatsTable createAlias(String alias) {
    return $CachedAiStatsTable(attachedDatabase, alias);
  }
}

class CachedAiStat extends DataClass implements Insertable<CachedAiStat> {
  final String workspaceId;
  final String peonId;
  final String period;
  final String payloadJson;
  final double updatedAt;
  const CachedAiStat({
    required this.workspaceId,
    required this.peonId,
    required this.period,
    required this.payloadJson,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['period'] = Variable<String>(period);
    map['payload_json'] = Variable<String>(payloadJson);
    map['updated_at'] = Variable<double>(updatedAt);
    return map;
  }

  CachedAiStatsCompanion toCompanion(bool nullToAbsent) {
    return CachedAiStatsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      period: Value(period),
      payloadJson: Value(payloadJson),
      updatedAt: Value(updatedAt),
    );
  }

  factory CachedAiStat.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedAiStat(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      period: serializer.fromJson<String>(json['period']),
      payloadJson: serializer.fromJson<String>(json['payloadJson']),
      updatedAt: serializer.fromJson<double>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'period': serializer.toJson<String>(period),
      'payloadJson': serializer.toJson<String>(payloadJson),
      'updatedAt': serializer.toJson<double>(updatedAt),
    };
  }

  CachedAiStat copyWith({
    String? workspaceId,
    String? peonId,
    String? period,
    String? payloadJson,
    double? updatedAt,
  }) => CachedAiStat(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    period: period ?? this.period,
    payloadJson: payloadJson ?? this.payloadJson,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  CachedAiStat copyWithCompanion(CachedAiStatsCompanion data) {
    return CachedAiStat(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      period: data.period.present ? data.period.value : this.period,
      payloadJson: data.payloadJson.present
          ? data.payloadJson.value
          : this.payloadJson,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedAiStat(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('period: $period, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, period, payloadJson, updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedAiStat &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.period == this.period &&
          other.payloadJson == this.payloadJson &&
          other.updatedAt == this.updatedAt);
}

class CachedAiStatsCompanion extends UpdateCompanion<CachedAiStat> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> period;
  final Value<String> payloadJson;
  final Value<double> updatedAt;
  final Value<int> rowid;
  const CachedAiStatsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.period = const Value.absent(),
    this.payloadJson = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedAiStatsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String period,
    required String payloadJson,
    required double updatedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       period = Value(period),
       payloadJson = Value(payloadJson),
       updatedAt = Value(updatedAt);
  static Insertable<CachedAiStat> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? period,
    Expression<String>? payloadJson,
    Expression<double>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (period != null) 'period': period,
      if (payloadJson != null) 'payload_json': payloadJson,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedAiStatsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? period,
    Value<String>? payloadJson,
    Value<double>? updatedAt,
    Value<int>? rowid,
  }) {
    return CachedAiStatsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      period: period ?? this.period,
      payloadJson: payloadJson ?? this.payloadJson,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (period.present) {
      map['period'] = Variable<String>(period.value);
    }
    if (payloadJson.present) {
      map['payload_json'] = Variable<String>(payloadJson.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<double>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedAiStatsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('period: $period, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedPeonManagementTable extends CachedPeonManagement
    with TableInfo<$CachedPeonManagementTable, CachedPeonManagementData> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedPeonManagementTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _kindMeta = const VerificationMeta('kind');
  @override
  late final GeneratedColumn<String> kind = GeneratedColumn<String>(
    'kind',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadJsonMeta = const VerificationMeta(
    'payloadJson',
  );
  @override
  late final GeneratedColumn<String> payloadJson = GeneratedColumn<String>(
    'payload_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<double> updatedAt = GeneratedColumn<double>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    kind,
    payloadJson,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_peon_management';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedPeonManagementData> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('kind')) {
      context.handle(
        _kindMeta,
        kind.isAcceptableOrUnknown(data['kind']!, _kindMeta),
      );
    } else if (isInserting) {
      context.missing(_kindMeta);
    }
    if (data.containsKey('payload_json')) {
      context.handle(
        _payloadJsonMeta,
        payloadJson.isAcceptableOrUnknown(
          data['payload_json']!,
          _payloadJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadJsonMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId, kind};
  @override
  CachedPeonManagementData map(
    Map<String, dynamic> data, {
    String? tablePrefix,
  }) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedPeonManagementData(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      kind: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}kind'],
      )!,
      payloadJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload_json'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $CachedPeonManagementTable createAlias(String alias) {
    return $CachedPeonManagementTable(attachedDatabase, alias);
  }
}

class CachedPeonManagementData extends DataClass
    implements Insertable<CachedPeonManagementData> {
  final String workspaceId;
  final String peonId;
  final String kind;
  final String payloadJson;
  final double updatedAt;
  const CachedPeonManagementData({
    required this.workspaceId,
    required this.peonId,
    required this.kind,
    required this.payloadJson,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['kind'] = Variable<String>(kind);
    map['payload_json'] = Variable<String>(payloadJson);
    map['updated_at'] = Variable<double>(updatedAt);
    return map;
  }

  CachedPeonManagementCompanion toCompanion(bool nullToAbsent) {
    return CachedPeonManagementCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      kind: Value(kind),
      payloadJson: Value(payloadJson),
      updatedAt: Value(updatedAt),
    );
  }

  factory CachedPeonManagementData.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedPeonManagementData(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      kind: serializer.fromJson<String>(json['kind']),
      payloadJson: serializer.fromJson<String>(json['payloadJson']),
      updatedAt: serializer.fromJson<double>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'kind': serializer.toJson<String>(kind),
      'payloadJson': serializer.toJson<String>(payloadJson),
      'updatedAt': serializer.toJson<double>(updatedAt),
    };
  }

  CachedPeonManagementData copyWith({
    String? workspaceId,
    String? peonId,
    String? kind,
    String? payloadJson,
    double? updatedAt,
  }) => CachedPeonManagementData(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    kind: kind ?? this.kind,
    payloadJson: payloadJson ?? this.payloadJson,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  CachedPeonManagementData copyWithCompanion(
    CachedPeonManagementCompanion data,
  ) {
    return CachedPeonManagementData(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      kind: data.kind.present ? data.kind.value : this.kind,
      payloadJson: data.payloadJson.present
          ? data.payloadJson.value
          : this.payloadJson,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedPeonManagementData(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('kind: $kind, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, kind, payloadJson, updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedPeonManagementData &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.kind == this.kind &&
          other.payloadJson == this.payloadJson &&
          other.updatedAt == this.updatedAt);
}

class CachedPeonManagementCompanion
    extends UpdateCompanion<CachedPeonManagementData> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> kind;
  final Value<String> payloadJson;
  final Value<double> updatedAt;
  final Value<int> rowid;
  const CachedPeonManagementCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.kind = const Value.absent(),
    this.payloadJson = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedPeonManagementCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String kind,
    required String payloadJson,
    required double updatedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       kind = Value(kind),
       payloadJson = Value(payloadJson),
       updatedAt = Value(updatedAt);
  static Insertable<CachedPeonManagementData> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? kind,
    Expression<String>? payloadJson,
    Expression<double>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (kind != null) 'kind': kind,
      if (payloadJson != null) 'payload_json': payloadJson,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedPeonManagementCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? kind,
    Value<String>? payloadJson,
    Value<double>? updatedAt,
    Value<int>? rowid,
  }) {
    return CachedPeonManagementCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      kind: kind ?? this.kind,
      payloadJson: payloadJson ?? this.payloadJson,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (kind.present) {
      map['kind'] = Variable<String>(kind.value);
    }
    if (payloadJson.present) {
      map['payload_json'] = Variable<String>(payloadJson.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<double>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedPeonManagementCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('kind: $kind, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $LiveCursorsTable extends LiveCursors
    with TableInfo<$LiveCursorsTable, LiveCursor> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $LiveCursorsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _cursorMeta = const VerificationMeta('cursor');
  @override
  late final GeneratedColumn<int> cursor = GeneratedColumn<int>(
    'cursor',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  @override
  List<GeneratedColumn> get $columns => [workspaceId, cursor];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'live_cursors';
  @override
  VerificationContext validateIntegrity(
    Insertable<LiveCursor> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('cursor')) {
      context.handle(
        _cursorMeta,
        cursor.isAcceptableOrUnknown(data['cursor']!, _cursorMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId};
  @override
  LiveCursor map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return LiveCursor(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      cursor: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}cursor'],
      )!,
    );
  }

  @override
  $LiveCursorsTable createAlias(String alias) {
    return $LiveCursorsTable(attachedDatabase, alias);
  }
}

class LiveCursor extends DataClass implements Insertable<LiveCursor> {
  final String workspaceId;
  final int cursor;
  const LiveCursor({required this.workspaceId, required this.cursor});
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['cursor'] = Variable<int>(cursor);
    return map;
  }

  LiveCursorsCompanion toCompanion(bool nullToAbsent) {
    return LiveCursorsCompanion(
      workspaceId: Value(workspaceId),
      cursor: Value(cursor),
    );
  }

  factory LiveCursor.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return LiveCursor(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      cursor: serializer.fromJson<int>(json['cursor']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'cursor': serializer.toJson<int>(cursor),
    };
  }

  LiveCursor copyWith({String? workspaceId, int? cursor}) => LiveCursor(
    workspaceId: workspaceId ?? this.workspaceId,
    cursor: cursor ?? this.cursor,
  );
  LiveCursor copyWithCompanion(LiveCursorsCompanion data) {
    return LiveCursor(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      cursor: data.cursor.present ? data.cursor.value : this.cursor,
    );
  }

  @override
  String toString() {
    return (StringBuffer('LiveCursor(')
          ..write('workspaceId: $workspaceId, ')
          ..write('cursor: $cursor')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(workspaceId, cursor);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is LiveCursor &&
          other.workspaceId == this.workspaceId &&
          other.cursor == this.cursor);
}

class LiveCursorsCompanion extends UpdateCompanion<LiveCursor> {
  final Value<String> workspaceId;
  final Value<int> cursor;
  final Value<int> rowid;
  const LiveCursorsCompanion({
    this.workspaceId = const Value.absent(),
    this.cursor = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  LiveCursorsCompanion.insert({
    required String workspaceId,
    this.cursor = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId);
  static Insertable<LiveCursor> custom({
    Expression<String>? workspaceId,
    Expression<int>? cursor,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (cursor != null) 'cursor': cursor,
      if (rowid != null) 'rowid': rowid,
    });
  }

  LiveCursorsCompanion copyWith({
    Value<String>? workspaceId,
    Value<int>? cursor,
    Value<int>? rowid,
  }) {
    return LiveCursorsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      cursor: cursor ?? this.cursor,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (cursor.present) {
      map['cursor'] = Variable<int>(cursor.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('LiveCursorsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('cursor: $cursor, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedTranscriptEventsTable extends CachedTranscriptEvents
    with TableInfo<$CachedTranscriptEventsTable, CachedTranscriptEvent> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedTranscriptEventsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _eventIdMeta = const VerificationMeta(
    'eventId',
  );
  @override
  late final GeneratedColumn<String> eventId = GeneratedColumn<String>(
    'event_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _orderKeyMeta = const VerificationMeta(
    'orderKey',
  );
  @override
  late final GeneratedColumn<int> orderKey = GeneratedColumn<int>(
    'order_key',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _eventTypeMeta = const VerificationMeta(
    'eventType',
  );
  @override
  late final GeneratedColumn<String> eventType = GeneratedColumn<String>(
    'event_type',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _payloadJsonMeta = const VerificationMeta(
    'payloadJson',
  );
  @override
  late final GeneratedColumn<String> payloadJson = GeneratedColumn<String>(
    'payload_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<double> createdAt = GeneratedColumn<double>(
    'created_at',
    aliasedName,
    true,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<double> updatedAt = GeneratedColumn<double>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    sessionId,
    eventId,
    orderKey,
    eventType,
    payloadJson,
    createdAt,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_transcript_events';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedTranscriptEvent> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('event_id')) {
      context.handle(
        _eventIdMeta,
        eventId.isAcceptableOrUnknown(data['event_id']!, _eventIdMeta),
      );
    } else if (isInserting) {
      context.missing(_eventIdMeta);
    }
    if (data.containsKey('order_key')) {
      context.handle(
        _orderKeyMeta,
        orderKey.isAcceptableOrUnknown(data['order_key']!, _orderKeyMeta),
      );
    } else if (isInserting) {
      context.missing(_orderKeyMeta);
    }
    if (data.containsKey('event_type')) {
      context.handle(
        _eventTypeMeta,
        eventType.isAcceptableOrUnknown(data['event_type']!, _eventTypeMeta),
      );
    }
    if (data.containsKey('payload_json')) {
      context.handle(
        _payloadJsonMeta,
        payloadJson.isAcceptableOrUnknown(
          data['payload_json']!,
          _payloadJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadJsonMeta);
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {
    workspaceId,
    peonId,
    sessionId,
    eventId,
  };
  @override
  CachedTranscriptEvent map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedTranscriptEvent(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      eventId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}event_id'],
      )!,
      orderKey: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}order_key'],
      )!,
      eventType: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}event_type'],
      ),
      payloadJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload_json'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}created_at'],
      ),
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $CachedTranscriptEventsTable createAlias(String alias) {
    return $CachedTranscriptEventsTable(attachedDatabase, alias);
  }
}

class CachedTranscriptEvent extends DataClass
    implements Insertable<CachedTranscriptEvent> {
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String eventId;
  final int orderKey;
  final String? eventType;
  final String payloadJson;
  final double? createdAt;
  final double updatedAt;
  const CachedTranscriptEvent({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.eventId,
    required this.orderKey,
    this.eventType,
    required this.payloadJson,
    this.createdAt,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['session_id'] = Variable<String>(sessionId);
    map['event_id'] = Variable<String>(eventId);
    map['order_key'] = Variable<int>(orderKey);
    if (!nullToAbsent || eventType != null) {
      map['event_type'] = Variable<String>(eventType);
    }
    map['payload_json'] = Variable<String>(payloadJson);
    if (!nullToAbsent || createdAt != null) {
      map['created_at'] = Variable<double>(createdAt);
    }
    map['updated_at'] = Variable<double>(updatedAt);
    return map;
  }

  CachedTranscriptEventsCompanion toCompanion(bool nullToAbsent) {
    return CachedTranscriptEventsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      sessionId: Value(sessionId),
      eventId: Value(eventId),
      orderKey: Value(orderKey),
      eventType: eventType == null && nullToAbsent
          ? const Value.absent()
          : Value(eventType),
      payloadJson: Value(payloadJson),
      createdAt: createdAt == null && nullToAbsent
          ? const Value.absent()
          : Value(createdAt),
      updatedAt: Value(updatedAt),
    );
  }

  factory CachedTranscriptEvent.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedTranscriptEvent(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      eventId: serializer.fromJson<String>(json['eventId']),
      orderKey: serializer.fromJson<int>(json['orderKey']),
      eventType: serializer.fromJson<String?>(json['eventType']),
      payloadJson: serializer.fromJson<String>(json['payloadJson']),
      createdAt: serializer.fromJson<double?>(json['createdAt']),
      updatedAt: serializer.fromJson<double>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'sessionId': serializer.toJson<String>(sessionId),
      'eventId': serializer.toJson<String>(eventId),
      'orderKey': serializer.toJson<int>(orderKey),
      'eventType': serializer.toJson<String?>(eventType),
      'payloadJson': serializer.toJson<String>(payloadJson),
      'createdAt': serializer.toJson<double?>(createdAt),
      'updatedAt': serializer.toJson<double>(updatedAt),
    };
  }

  CachedTranscriptEvent copyWith({
    String? workspaceId,
    String? peonId,
    String? sessionId,
    String? eventId,
    int? orderKey,
    Value<String?> eventType = const Value.absent(),
    String? payloadJson,
    Value<double?> createdAt = const Value.absent(),
    double? updatedAt,
  }) => CachedTranscriptEvent(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    sessionId: sessionId ?? this.sessionId,
    eventId: eventId ?? this.eventId,
    orderKey: orderKey ?? this.orderKey,
    eventType: eventType.present ? eventType.value : this.eventType,
    payloadJson: payloadJson ?? this.payloadJson,
    createdAt: createdAt.present ? createdAt.value : this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  CachedTranscriptEvent copyWithCompanion(
    CachedTranscriptEventsCompanion data,
  ) {
    return CachedTranscriptEvent(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      eventId: data.eventId.present ? data.eventId.value : this.eventId,
      orderKey: data.orderKey.present ? data.orderKey.value : this.orderKey,
      eventType: data.eventType.present ? data.eventType.value : this.eventType,
      payloadJson: data.payloadJson.present
          ? data.payloadJson.value
          : this.payloadJson,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedTranscriptEvent(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('eventId: $eventId, ')
          ..write('orderKey: $orderKey, ')
          ..write('eventType: $eventType, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    workspaceId,
    peonId,
    sessionId,
    eventId,
    orderKey,
    eventType,
    payloadJson,
    createdAt,
    updatedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedTranscriptEvent &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.sessionId == this.sessionId &&
          other.eventId == this.eventId &&
          other.orderKey == this.orderKey &&
          other.eventType == this.eventType &&
          other.payloadJson == this.payloadJson &&
          other.createdAt == this.createdAt &&
          other.updatedAt == this.updatedAt);
}

class CachedTranscriptEventsCompanion
    extends UpdateCompanion<CachedTranscriptEvent> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> sessionId;
  final Value<String> eventId;
  final Value<int> orderKey;
  final Value<String?> eventType;
  final Value<String> payloadJson;
  final Value<double?> createdAt;
  final Value<double> updatedAt;
  final Value<int> rowid;
  const CachedTranscriptEventsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.eventId = const Value.absent(),
    this.orderKey = const Value.absent(),
    this.eventType = const Value.absent(),
    this.payloadJson = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedTranscriptEventsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String eventId,
    required int orderKey,
    this.eventType = const Value.absent(),
    required String payloadJson,
    this.createdAt = const Value.absent(),
    required double updatedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       sessionId = Value(sessionId),
       eventId = Value(eventId),
       orderKey = Value(orderKey),
       payloadJson = Value(payloadJson),
       updatedAt = Value(updatedAt);
  static Insertable<CachedTranscriptEvent> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? sessionId,
    Expression<String>? eventId,
    Expression<int>? orderKey,
    Expression<String>? eventType,
    Expression<String>? payloadJson,
    Expression<double>? createdAt,
    Expression<double>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (sessionId != null) 'session_id': sessionId,
      if (eventId != null) 'event_id': eventId,
      if (orderKey != null) 'order_key': orderKey,
      if (eventType != null) 'event_type': eventType,
      if (payloadJson != null) 'payload_json': payloadJson,
      if (createdAt != null) 'created_at': createdAt,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedTranscriptEventsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? sessionId,
    Value<String>? eventId,
    Value<int>? orderKey,
    Value<String?>? eventType,
    Value<String>? payloadJson,
    Value<double?>? createdAt,
    Value<double>? updatedAt,
    Value<int>? rowid,
  }) {
    return CachedTranscriptEventsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      sessionId: sessionId ?? this.sessionId,
      eventId: eventId ?? this.eventId,
      orderKey: orderKey ?? this.orderKey,
      eventType: eventType ?? this.eventType,
      payloadJson: payloadJson ?? this.payloadJson,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (eventId.present) {
      map['event_id'] = Variable<String>(eventId.value);
    }
    if (orderKey.present) {
      map['order_key'] = Variable<int>(orderKey.value);
    }
    if (eventType.present) {
      map['event_type'] = Variable<String>(eventType.value);
    }
    if (payloadJson.present) {
      map['payload_json'] = Variable<String>(payloadJson.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<double>(createdAt.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<double>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedTranscriptEventsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('eventId: $eventId, ')
          ..write('orderKey: $orderKey, ')
          ..write('eventType: $eventType, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('createdAt: $createdAt, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedTranscriptsTable extends CachedTranscripts
    with TableInfo<$CachedTranscriptsTable, CachedTranscript> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedTranscriptsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _hasOlderMeta = const VerificationMeta(
    'hasOlder',
  );
  @override
  late final GeneratedColumn<bool> hasOlder = GeneratedColumn<bool>(
    'has_older',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("has_older" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<double> syncedAt = GeneratedColumn<double>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: false,
    defaultValue: const Constant(0),
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    sessionId,
    hasOlder,
    syncedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_transcripts';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedTranscript> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('has_older')) {
      context.handle(
        _hasOlderMeta,
        hasOlder.isAcceptableOrUnknown(data['has_older']!, _hasOlderMeta),
      );
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId, sessionId};
  @override
  CachedTranscript map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedTranscript(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      hasOlder: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}has_older'],
      )!,
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}synced_at'],
      )!,
    );
  }

  @override
  $CachedTranscriptsTable createAlias(String alias) {
    return $CachedTranscriptsTable(attachedDatabase, alias);
  }
}

class CachedTranscript extends DataClass
    implements Insertable<CachedTranscript> {
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final bool hasOlder;
  final double syncedAt;
  const CachedTranscript({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.hasOlder,
    required this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['session_id'] = Variable<String>(sessionId);
    map['has_older'] = Variable<bool>(hasOlder);
    map['synced_at'] = Variable<double>(syncedAt);
    return map;
  }

  CachedTranscriptsCompanion toCompanion(bool nullToAbsent) {
    return CachedTranscriptsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      sessionId: Value(sessionId),
      hasOlder: Value(hasOlder),
      syncedAt: Value(syncedAt),
    );
  }

  factory CachedTranscript.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedTranscript(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      hasOlder: serializer.fromJson<bool>(json['hasOlder']),
      syncedAt: serializer.fromJson<double>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'sessionId': serializer.toJson<String>(sessionId),
      'hasOlder': serializer.toJson<bool>(hasOlder),
      'syncedAt': serializer.toJson<double>(syncedAt),
    };
  }

  CachedTranscript copyWith({
    String? workspaceId,
    String? peonId,
    String? sessionId,
    bool? hasOlder,
    double? syncedAt,
  }) => CachedTranscript(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    sessionId: sessionId ?? this.sessionId,
    hasOlder: hasOlder ?? this.hasOlder,
    syncedAt: syncedAt ?? this.syncedAt,
  );
  CachedTranscript copyWithCompanion(CachedTranscriptsCompanion data) {
    return CachedTranscript(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      hasOlder: data.hasOlder.present ? data.hasOlder.value : this.hasOlder,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedTranscript(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('hasOlder: $hasOlder, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, sessionId, hasOlder, syncedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedTranscript &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.sessionId == this.sessionId &&
          other.hasOlder == this.hasOlder &&
          other.syncedAt == this.syncedAt);
}

class CachedTranscriptsCompanion extends UpdateCompanion<CachedTranscript> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> sessionId;
  final Value<bool> hasOlder;
  final Value<double> syncedAt;
  final Value<int> rowid;
  const CachedTranscriptsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.hasOlder = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedTranscriptsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    this.hasOlder = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       sessionId = Value(sessionId);
  static Insertable<CachedTranscript> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? sessionId,
    Expression<bool>? hasOlder,
    Expression<double>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (sessionId != null) 'session_id': sessionId,
      if (hasOlder != null) 'has_older': hasOlder,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedTranscriptsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? sessionId,
    Value<bool>? hasOlder,
    Value<double>? syncedAt,
    Value<int>? rowid,
  }) {
    return CachedTranscriptsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      sessionId: sessionId ?? this.sessionId,
      hasOlder: hasOlder ?? this.hasOlder,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (hasOlder.present) {
      map['has_older'] = Variable<bool>(hasOlder.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<double>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedTranscriptsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('hasOlder: $hasOlder, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $ComposerDraftsTable extends ComposerDrafts
    with TableInfo<$ComposerDraftsTable, ComposerDraft> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $ComposerDraftsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _draftTextMeta = const VerificationMeta(
    'draftText',
  );
  @override
  late final GeneratedColumn<String> draftText = GeneratedColumn<String>(
    'draft_text',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _updatedAtMeta = const VerificationMeta(
    'updatedAt',
  );
  @override
  late final GeneratedColumn<double> updatedAt = GeneratedColumn<double>(
    'updated_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    sessionId,
    draftText,
    updatedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'composer_drafts';
  @override
  VerificationContext validateIntegrity(
    Insertable<ComposerDraft> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('draft_text')) {
      context.handle(
        _draftTextMeta,
        draftText.isAcceptableOrUnknown(data['draft_text']!, _draftTextMeta),
      );
    } else if (isInserting) {
      context.missing(_draftTextMeta);
    }
    if (data.containsKey('updated_at')) {
      context.handle(
        _updatedAtMeta,
        updatedAt.isAcceptableOrUnknown(data['updated_at']!, _updatedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_updatedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {workspaceId, peonId, sessionId};
  @override
  ComposerDraft map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return ComposerDraft(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      draftText: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}draft_text'],
      )!,
      updatedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}updated_at'],
      )!,
    );
  }

  @override
  $ComposerDraftsTable createAlias(String alias) {
    return $ComposerDraftsTable(attachedDatabase, alias);
  }
}

class ComposerDraft extends DataClass implements Insertable<ComposerDraft> {
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String draftText;
  final double updatedAt;
  const ComposerDraft({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.draftText,
    required this.updatedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['session_id'] = Variable<String>(sessionId);
    map['draft_text'] = Variable<String>(draftText);
    map['updated_at'] = Variable<double>(updatedAt);
    return map;
  }

  ComposerDraftsCompanion toCompanion(bool nullToAbsent) {
    return ComposerDraftsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      sessionId: Value(sessionId),
      draftText: Value(draftText),
      updatedAt: Value(updatedAt),
    );
  }

  factory ComposerDraft.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return ComposerDraft(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      draftText: serializer.fromJson<String>(json['draftText']),
      updatedAt: serializer.fromJson<double>(json['updatedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'sessionId': serializer.toJson<String>(sessionId),
      'draftText': serializer.toJson<String>(draftText),
      'updatedAt': serializer.toJson<double>(updatedAt),
    };
  }

  ComposerDraft copyWith({
    String? workspaceId,
    String? peonId,
    String? sessionId,
    String? draftText,
    double? updatedAt,
  }) => ComposerDraft(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    sessionId: sessionId ?? this.sessionId,
    draftText: draftText ?? this.draftText,
    updatedAt: updatedAt ?? this.updatedAt,
  );
  ComposerDraft copyWithCompanion(ComposerDraftsCompanion data) {
    return ComposerDraft(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      draftText: data.draftText.present ? data.draftText.value : this.draftText,
      updatedAt: data.updatedAt.present ? data.updatedAt.value : this.updatedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('ComposerDraft(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('draftText: $draftText, ')
          ..write('updatedAt: $updatedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, sessionId, draftText, updatedAt);
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is ComposerDraft &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.sessionId == this.sessionId &&
          other.draftText == this.draftText &&
          other.updatedAt == this.updatedAt);
}

class ComposerDraftsCompanion extends UpdateCompanion<ComposerDraft> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> sessionId;
  final Value<String> draftText;
  final Value<double> updatedAt;
  final Value<int> rowid;
  const ComposerDraftsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.draftText = const Value.absent(),
    this.updatedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  ComposerDraftsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String draftText,
    required double updatedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       sessionId = Value(sessionId),
       draftText = Value(draftText),
       updatedAt = Value(updatedAt);
  static Insertable<ComposerDraft> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? sessionId,
    Expression<String>? draftText,
    Expression<double>? updatedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (sessionId != null) 'session_id': sessionId,
      if (draftText != null) 'draft_text': draftText,
      if (updatedAt != null) 'updated_at': updatedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  ComposerDraftsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? sessionId,
    Value<String>? draftText,
    Value<double>? updatedAt,
    Value<int>? rowid,
  }) {
    return ComposerDraftsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      sessionId: sessionId ?? this.sessionId,
      draftText: draftText ?? this.draftText,
      updatedAt: updatedAt ?? this.updatedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (draftText.present) {
      map['draft_text'] = Variable<String>(draftText.value);
    }
    if (updatedAt.present) {
      map['updated_at'] = Variable<double>(updatedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('ComposerDraftsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('draftText: $draftText, ')
          ..write('updatedAt: $updatedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $PendingFollowupCommandsTable extends PendingFollowupCommands
    with TableInfo<$PendingFollowupCommandsTable, PendingFollowupCommand> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $PendingFollowupCommandsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _commandIdMeta = const VerificationMeta(
    'commandId',
  );
  @override
  late final GeneratedColumn<String> commandId = GeneratedColumn<String>(
    'command_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _promptMeta = const VerificationMeta('prompt');
  @override
  late final GeneratedColumn<String> prompt = GeneratedColumn<String>(
    'prompt',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _serverQueueMeta = const VerificationMeta(
    'serverQueue',
  );
  @override
  late final GeneratedColumn<bool> serverQueue = GeneratedColumn<bool>(
    'server_queue',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: true,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("server_queue" IN (0, 1))',
    ),
  );
  static const VerificationMeta _startNowMeta = const VerificationMeta(
    'startNow',
  );
  @override
  late final GeneratedColumn<bool> startNow = GeneratedColumn<bool>(
    'start_now',
    aliasedName,
    false,
    type: DriftSqlType.bool,
    requiredDuringInsert: false,
    defaultConstraints: GeneratedColumn.constraintIsAlways(
      'CHECK ("start_now" IN (0, 1))',
    ),
    defaultValue: const Constant(false),
  );
  static const VerificationMeta _agentMeta = const VerificationMeta('agent');
  @override
  late final GeneratedColumn<String> agent = GeneratedColumn<String>(
    'agent',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _modelMeta = const VerificationMeta('model');
  @override
  late final GeneratedColumn<String> model = GeneratedColumn<String>(
    'model',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _reasoningEffortMeta = const VerificationMeta(
    'reasoningEffort',
  );
  @override
  late final GeneratedColumn<String> reasoningEffort = GeneratedColumn<String>(
    'reasoning_effort',
    aliasedName,
    true,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
  );
  static const VerificationMeta _attachmentsJsonMeta = const VerificationMeta(
    'attachmentsJson',
  );
  @override
  late final GeneratedColumn<String> attachmentsJson = GeneratedColumn<String>(
    'attachments_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: false,
    defaultValue: const Constant('[]'),
  );
  static const VerificationMeta _createdAtMeta = const VerificationMeta(
    'createdAt',
  );
  @override
  late final GeneratedColumn<double> createdAt = GeneratedColumn<double>(
    'created_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    commandId,
    workspaceId,
    peonId,
    sessionId,
    prompt,
    serverQueue,
    startNow,
    agent,
    model,
    reasoningEffort,
    attachmentsJson,
    createdAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'pending_followup_commands';
  @override
  VerificationContext validateIntegrity(
    Insertable<PendingFollowupCommand> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('command_id')) {
      context.handle(
        _commandIdMeta,
        commandId.isAcceptableOrUnknown(data['command_id']!, _commandIdMeta),
      );
    } else if (isInserting) {
      context.missing(_commandIdMeta);
    }
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('prompt')) {
      context.handle(
        _promptMeta,
        prompt.isAcceptableOrUnknown(data['prompt']!, _promptMeta),
      );
    } else if (isInserting) {
      context.missing(_promptMeta);
    }
    if (data.containsKey('server_queue')) {
      context.handle(
        _serverQueueMeta,
        serverQueue.isAcceptableOrUnknown(
          data['server_queue']!,
          _serverQueueMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_serverQueueMeta);
    }
    if (data.containsKey('start_now')) {
      context.handle(
        _startNowMeta,
        startNow.isAcceptableOrUnknown(data['start_now']!, _startNowMeta),
      );
    }
    if (data.containsKey('agent')) {
      context.handle(
        _agentMeta,
        agent.isAcceptableOrUnknown(data['agent']!, _agentMeta),
      );
    }
    if (data.containsKey('model')) {
      context.handle(
        _modelMeta,
        model.isAcceptableOrUnknown(data['model']!, _modelMeta),
      );
    }
    if (data.containsKey('reasoning_effort')) {
      context.handle(
        _reasoningEffortMeta,
        reasoningEffort.isAcceptableOrUnknown(
          data['reasoning_effort']!,
          _reasoningEffortMeta,
        ),
      );
    }
    if (data.containsKey('attachments_json')) {
      context.handle(
        _attachmentsJsonMeta,
        attachmentsJson.isAcceptableOrUnknown(
          data['attachments_json']!,
          _attachmentsJsonMeta,
        ),
      );
    }
    if (data.containsKey('created_at')) {
      context.handle(
        _createdAtMeta,
        createdAt.isAcceptableOrUnknown(data['created_at']!, _createdAtMeta),
      );
    } else if (isInserting) {
      context.missing(_createdAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {commandId};
  @override
  PendingFollowupCommand map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return PendingFollowupCommand(
      commandId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}command_id'],
      )!,
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      prompt: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}prompt'],
      )!,
      serverQueue: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}server_queue'],
      )!,
      startNow: attachedDatabase.typeMapping.read(
        DriftSqlType.bool,
        data['${effectivePrefix}start_now'],
      )!,
      agent: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}agent'],
      ),
      model: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}model'],
      ),
      reasoningEffort: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}reasoning_effort'],
      ),
      attachmentsJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}attachments_json'],
      )!,
      createdAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}created_at'],
      )!,
    );
  }

  @override
  $PendingFollowupCommandsTable createAlias(String alias) {
    return $PendingFollowupCommandsTable(attachedDatabase, alias);
  }
}

class PendingFollowupCommand extends DataClass
    implements Insertable<PendingFollowupCommand> {
  final String commandId;
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String prompt;
  final bool serverQueue;
  final bool startNow;
  final String? agent;
  final String? model;
  final String? reasoningEffort;
  final String attachmentsJson;
  final double createdAt;
  const PendingFollowupCommand({
    required this.commandId,
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.prompt,
    required this.serverQueue,
    required this.startNow,
    this.agent,
    this.model,
    this.reasoningEffort,
    required this.attachmentsJson,
    required this.createdAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['command_id'] = Variable<String>(commandId);
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['session_id'] = Variable<String>(sessionId);
    map['prompt'] = Variable<String>(prompt);
    map['server_queue'] = Variable<bool>(serverQueue);
    map['start_now'] = Variable<bool>(startNow);
    if (!nullToAbsent || agent != null) {
      map['agent'] = Variable<String>(agent);
    }
    if (!nullToAbsent || model != null) {
      map['model'] = Variable<String>(model);
    }
    if (!nullToAbsent || reasoningEffort != null) {
      map['reasoning_effort'] = Variable<String>(reasoningEffort);
    }
    map['attachments_json'] = Variable<String>(attachmentsJson);
    map['created_at'] = Variable<double>(createdAt);
    return map;
  }

  PendingFollowupCommandsCompanion toCompanion(bool nullToAbsent) {
    return PendingFollowupCommandsCompanion(
      commandId: Value(commandId),
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      sessionId: Value(sessionId),
      prompt: Value(prompt),
      serverQueue: Value(serverQueue),
      startNow: Value(startNow),
      agent: agent == null && nullToAbsent
          ? const Value.absent()
          : Value(agent),
      model: model == null && nullToAbsent
          ? const Value.absent()
          : Value(model),
      reasoningEffort: reasoningEffort == null && nullToAbsent
          ? const Value.absent()
          : Value(reasoningEffort),
      attachmentsJson: Value(attachmentsJson),
      createdAt: Value(createdAt),
    );
  }

  factory PendingFollowupCommand.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return PendingFollowupCommand(
      commandId: serializer.fromJson<String>(json['commandId']),
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      prompt: serializer.fromJson<String>(json['prompt']),
      serverQueue: serializer.fromJson<bool>(json['serverQueue']),
      startNow: serializer.fromJson<bool>(json['startNow']),
      agent: serializer.fromJson<String?>(json['agent']),
      model: serializer.fromJson<String?>(json['model']),
      reasoningEffort: serializer.fromJson<String?>(json['reasoningEffort']),
      attachmentsJson: serializer.fromJson<String>(json['attachmentsJson']),
      createdAt: serializer.fromJson<double>(json['createdAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'commandId': serializer.toJson<String>(commandId),
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'sessionId': serializer.toJson<String>(sessionId),
      'prompt': serializer.toJson<String>(prompt),
      'serverQueue': serializer.toJson<bool>(serverQueue),
      'startNow': serializer.toJson<bool>(startNow),
      'agent': serializer.toJson<String?>(agent),
      'model': serializer.toJson<String?>(model),
      'reasoningEffort': serializer.toJson<String?>(reasoningEffort),
      'attachmentsJson': serializer.toJson<String>(attachmentsJson),
      'createdAt': serializer.toJson<double>(createdAt),
    };
  }

  PendingFollowupCommand copyWith({
    String? commandId,
    String? workspaceId,
    String? peonId,
    String? sessionId,
    String? prompt,
    bool? serverQueue,
    bool? startNow,
    Value<String?> agent = const Value.absent(),
    Value<String?> model = const Value.absent(),
    Value<String?> reasoningEffort = const Value.absent(),
    String? attachmentsJson,
    double? createdAt,
  }) => PendingFollowupCommand(
    commandId: commandId ?? this.commandId,
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    sessionId: sessionId ?? this.sessionId,
    prompt: prompt ?? this.prompt,
    serverQueue: serverQueue ?? this.serverQueue,
    startNow: startNow ?? this.startNow,
    agent: agent.present ? agent.value : this.agent,
    model: model.present ? model.value : this.model,
    reasoningEffort: reasoningEffort.present
        ? reasoningEffort.value
        : this.reasoningEffort,
    attachmentsJson: attachmentsJson ?? this.attachmentsJson,
    createdAt: createdAt ?? this.createdAt,
  );
  PendingFollowupCommand copyWithCompanion(
    PendingFollowupCommandsCompanion data,
  ) {
    return PendingFollowupCommand(
      commandId: data.commandId.present ? data.commandId.value : this.commandId,
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      prompt: data.prompt.present ? data.prompt.value : this.prompt,
      serverQueue: data.serverQueue.present
          ? data.serverQueue.value
          : this.serverQueue,
      startNow: data.startNow.present ? data.startNow.value : this.startNow,
      agent: data.agent.present ? data.agent.value : this.agent,
      model: data.model.present ? data.model.value : this.model,
      reasoningEffort: data.reasoningEffort.present
          ? data.reasoningEffort.value
          : this.reasoningEffort,
      attachmentsJson: data.attachmentsJson.present
          ? data.attachmentsJson.value
          : this.attachmentsJson,
      createdAt: data.createdAt.present ? data.createdAt.value : this.createdAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('PendingFollowupCommand(')
          ..write('commandId: $commandId, ')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('prompt: $prompt, ')
          ..write('serverQueue: $serverQueue, ')
          ..write('startNow: $startNow, ')
          ..write('agent: $agent, ')
          ..write('model: $model, ')
          ..write('reasoningEffort: $reasoningEffort, ')
          ..write('attachmentsJson: $attachmentsJson, ')
          ..write('createdAt: $createdAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    commandId,
    workspaceId,
    peonId,
    sessionId,
    prompt,
    serverQueue,
    startNow,
    agent,
    model,
    reasoningEffort,
    attachmentsJson,
    createdAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is PendingFollowupCommand &&
          other.commandId == this.commandId &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.sessionId == this.sessionId &&
          other.prompt == this.prompt &&
          other.serverQueue == this.serverQueue &&
          other.startNow == this.startNow &&
          other.agent == this.agent &&
          other.model == this.model &&
          other.reasoningEffort == this.reasoningEffort &&
          other.attachmentsJson == this.attachmentsJson &&
          other.createdAt == this.createdAt);
}

class PendingFollowupCommandsCompanion
    extends UpdateCompanion<PendingFollowupCommand> {
  final Value<String> commandId;
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> sessionId;
  final Value<String> prompt;
  final Value<bool> serverQueue;
  final Value<bool> startNow;
  final Value<String?> agent;
  final Value<String?> model;
  final Value<String?> reasoningEffort;
  final Value<String> attachmentsJson;
  final Value<double> createdAt;
  final Value<int> rowid;
  const PendingFollowupCommandsCompanion({
    this.commandId = const Value.absent(),
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.prompt = const Value.absent(),
    this.serverQueue = const Value.absent(),
    this.startNow = const Value.absent(),
    this.agent = const Value.absent(),
    this.model = const Value.absent(),
    this.reasoningEffort = const Value.absent(),
    this.attachmentsJson = const Value.absent(),
    this.createdAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  PendingFollowupCommandsCompanion.insert({
    required String commandId,
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String prompt,
    required bool serverQueue,
    this.startNow = const Value.absent(),
    this.agent = const Value.absent(),
    this.model = const Value.absent(),
    this.reasoningEffort = const Value.absent(),
    this.attachmentsJson = const Value.absent(),
    required double createdAt,
    this.rowid = const Value.absent(),
  }) : commandId = Value(commandId),
       workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       sessionId = Value(sessionId),
       prompt = Value(prompt),
       serverQueue = Value(serverQueue),
       createdAt = Value(createdAt);
  static Insertable<PendingFollowupCommand> custom({
    Expression<String>? commandId,
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? sessionId,
    Expression<String>? prompt,
    Expression<bool>? serverQueue,
    Expression<bool>? startNow,
    Expression<String>? agent,
    Expression<String>? model,
    Expression<String>? reasoningEffort,
    Expression<String>? attachmentsJson,
    Expression<double>? createdAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (commandId != null) 'command_id': commandId,
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (sessionId != null) 'session_id': sessionId,
      if (prompt != null) 'prompt': prompt,
      if (serverQueue != null) 'server_queue': serverQueue,
      if (startNow != null) 'start_now': startNow,
      if (agent != null) 'agent': agent,
      if (model != null) 'model': model,
      if (reasoningEffort != null) 'reasoning_effort': reasoningEffort,
      if (attachmentsJson != null) 'attachments_json': attachmentsJson,
      if (createdAt != null) 'created_at': createdAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  PendingFollowupCommandsCompanion copyWith({
    Value<String>? commandId,
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? sessionId,
    Value<String>? prompt,
    Value<bool>? serverQueue,
    Value<bool>? startNow,
    Value<String?>? agent,
    Value<String?>? model,
    Value<String?>? reasoningEffort,
    Value<String>? attachmentsJson,
    Value<double>? createdAt,
    Value<int>? rowid,
  }) {
    return PendingFollowupCommandsCompanion(
      commandId: commandId ?? this.commandId,
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      sessionId: sessionId ?? this.sessionId,
      prompt: prompt ?? this.prompt,
      serverQueue: serverQueue ?? this.serverQueue,
      startNow: startNow ?? this.startNow,
      agent: agent ?? this.agent,
      model: model ?? this.model,
      reasoningEffort: reasoningEffort ?? this.reasoningEffort,
      attachmentsJson: attachmentsJson ?? this.attachmentsJson,
      createdAt: createdAt ?? this.createdAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (commandId.present) {
      map['command_id'] = Variable<String>(commandId.value);
    }
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (prompt.present) {
      map['prompt'] = Variable<String>(prompt.value);
    }
    if (serverQueue.present) {
      map['server_queue'] = Variable<bool>(serverQueue.value);
    }
    if (startNow.present) {
      map['start_now'] = Variable<bool>(startNow.value);
    }
    if (agent.present) {
      map['agent'] = Variable<String>(agent.value);
    }
    if (model.present) {
      map['model'] = Variable<String>(model.value);
    }
    if (reasoningEffort.present) {
      map['reasoning_effort'] = Variable<String>(reasoningEffort.value);
    }
    if (attachmentsJson.present) {
      map['attachments_json'] = Variable<String>(attachmentsJson.value);
    }
    if (createdAt.present) {
      map['created_at'] = Variable<double>(createdAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('PendingFollowupCommandsCompanion(')
          ..write('commandId: $commandId, ')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('prompt: $prompt, ')
          ..write('serverQueue: $serverQueue, ')
          ..write('startNow: $startNow, ')
          ..write('agent: $agent, ')
          ..write('model: $model, ')
          ..write('reasoningEffort: $reasoningEffort, ')
          ..write('attachmentsJson: $attachmentsJson, ')
          ..write('createdAt: $createdAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

class $CachedQueuedFollowupsTable extends CachedQueuedFollowups
    with TableInfo<$CachedQueuedFollowupsTable, CachedQueuedFollowup> {
  @override
  final GeneratedDatabase attachedDatabase;
  final String? _alias;
  $CachedQueuedFollowupsTable(this.attachedDatabase, [this._alias]);
  static const VerificationMeta _workspaceIdMeta = const VerificationMeta(
    'workspaceId',
  );
  @override
  late final GeneratedColumn<String> workspaceId = GeneratedColumn<String>(
    'workspace_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _peonIdMeta = const VerificationMeta('peonId');
  @override
  late final GeneratedColumn<String> peonId = GeneratedColumn<String>(
    'peon_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _sessionIdMeta = const VerificationMeta(
    'sessionId',
  );
  @override
  late final GeneratedColumn<String> sessionId = GeneratedColumn<String>(
    'session_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _itemIdMeta = const VerificationMeta('itemId');
  @override
  late final GeneratedColumn<String> itemId = GeneratedColumn<String>(
    'item_id',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _payloadJsonMeta = const VerificationMeta(
    'payloadJson',
  );
  @override
  late final GeneratedColumn<String> payloadJson = GeneratedColumn<String>(
    'payload_json',
    aliasedName,
    false,
    type: DriftSqlType.string,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _orderKeyMeta = const VerificationMeta(
    'orderKey',
  );
  @override
  late final GeneratedColumn<int> orderKey = GeneratedColumn<int>(
    'order_key',
    aliasedName,
    false,
    type: DriftSqlType.int,
    requiredDuringInsert: true,
  );
  static const VerificationMeta _syncedAtMeta = const VerificationMeta(
    'syncedAt',
  );
  @override
  late final GeneratedColumn<double> syncedAt = GeneratedColumn<double>(
    'synced_at',
    aliasedName,
    false,
    type: DriftSqlType.double,
    requiredDuringInsert: true,
  );
  @override
  List<GeneratedColumn> get $columns => [
    workspaceId,
    peonId,
    sessionId,
    itemId,
    payloadJson,
    orderKey,
    syncedAt,
  ];
  @override
  String get aliasedName => _alias ?? actualTableName;
  @override
  String get actualTableName => $name;
  static const String $name = 'cached_queued_followups';
  @override
  VerificationContext validateIntegrity(
    Insertable<CachedQueuedFollowup> instance, {
    bool isInserting = false,
  }) {
    final context = VerificationContext();
    final data = instance.toColumns(true);
    if (data.containsKey('workspace_id')) {
      context.handle(
        _workspaceIdMeta,
        workspaceId.isAcceptableOrUnknown(
          data['workspace_id']!,
          _workspaceIdMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_workspaceIdMeta);
    }
    if (data.containsKey('peon_id')) {
      context.handle(
        _peonIdMeta,
        peonId.isAcceptableOrUnknown(data['peon_id']!, _peonIdMeta),
      );
    } else if (isInserting) {
      context.missing(_peonIdMeta);
    }
    if (data.containsKey('session_id')) {
      context.handle(
        _sessionIdMeta,
        sessionId.isAcceptableOrUnknown(data['session_id']!, _sessionIdMeta),
      );
    } else if (isInserting) {
      context.missing(_sessionIdMeta);
    }
    if (data.containsKey('item_id')) {
      context.handle(
        _itemIdMeta,
        itemId.isAcceptableOrUnknown(data['item_id']!, _itemIdMeta),
      );
    } else if (isInserting) {
      context.missing(_itemIdMeta);
    }
    if (data.containsKey('payload_json')) {
      context.handle(
        _payloadJsonMeta,
        payloadJson.isAcceptableOrUnknown(
          data['payload_json']!,
          _payloadJsonMeta,
        ),
      );
    } else if (isInserting) {
      context.missing(_payloadJsonMeta);
    }
    if (data.containsKey('order_key')) {
      context.handle(
        _orderKeyMeta,
        orderKey.isAcceptableOrUnknown(data['order_key']!, _orderKeyMeta),
      );
    } else if (isInserting) {
      context.missing(_orderKeyMeta);
    }
    if (data.containsKey('synced_at')) {
      context.handle(
        _syncedAtMeta,
        syncedAt.isAcceptableOrUnknown(data['synced_at']!, _syncedAtMeta),
      );
    } else if (isInserting) {
      context.missing(_syncedAtMeta);
    }
    return context;
  }

  @override
  Set<GeneratedColumn> get $primaryKey => {
    workspaceId,
    peonId,
    sessionId,
    itemId,
  };
  @override
  CachedQueuedFollowup map(Map<String, dynamic> data, {String? tablePrefix}) {
    final effectivePrefix = tablePrefix != null ? '$tablePrefix.' : '';
    return CachedQueuedFollowup(
      workspaceId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}workspace_id'],
      )!,
      peonId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}peon_id'],
      )!,
      sessionId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}session_id'],
      )!,
      itemId: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}item_id'],
      )!,
      payloadJson: attachedDatabase.typeMapping.read(
        DriftSqlType.string,
        data['${effectivePrefix}payload_json'],
      )!,
      orderKey: attachedDatabase.typeMapping.read(
        DriftSqlType.int,
        data['${effectivePrefix}order_key'],
      )!,
      syncedAt: attachedDatabase.typeMapping.read(
        DriftSqlType.double,
        data['${effectivePrefix}synced_at'],
      )!,
    );
  }

  @override
  $CachedQueuedFollowupsTable createAlias(String alias) {
    return $CachedQueuedFollowupsTable(attachedDatabase, alias);
  }
}

class CachedQueuedFollowup extends DataClass
    implements Insertable<CachedQueuedFollowup> {
  final String workspaceId;
  final String peonId;
  final String sessionId;
  final String itemId;
  final String payloadJson;
  final int orderKey;
  final double syncedAt;
  const CachedQueuedFollowup({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    required this.itemId,
    required this.payloadJson,
    required this.orderKey,
    required this.syncedAt,
  });
  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    map['workspace_id'] = Variable<String>(workspaceId);
    map['peon_id'] = Variable<String>(peonId);
    map['session_id'] = Variable<String>(sessionId);
    map['item_id'] = Variable<String>(itemId);
    map['payload_json'] = Variable<String>(payloadJson);
    map['order_key'] = Variable<int>(orderKey);
    map['synced_at'] = Variable<double>(syncedAt);
    return map;
  }

  CachedQueuedFollowupsCompanion toCompanion(bool nullToAbsent) {
    return CachedQueuedFollowupsCompanion(
      workspaceId: Value(workspaceId),
      peonId: Value(peonId),
      sessionId: Value(sessionId),
      itemId: Value(itemId),
      payloadJson: Value(payloadJson),
      orderKey: Value(orderKey),
      syncedAt: Value(syncedAt),
    );
  }

  factory CachedQueuedFollowup.fromJson(
    Map<String, dynamic> json, {
    ValueSerializer? serializer,
  }) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return CachedQueuedFollowup(
      workspaceId: serializer.fromJson<String>(json['workspaceId']),
      peonId: serializer.fromJson<String>(json['peonId']),
      sessionId: serializer.fromJson<String>(json['sessionId']),
      itemId: serializer.fromJson<String>(json['itemId']),
      payloadJson: serializer.fromJson<String>(json['payloadJson']),
      orderKey: serializer.fromJson<int>(json['orderKey']),
      syncedAt: serializer.fromJson<double>(json['syncedAt']),
    );
  }
  @override
  Map<String, dynamic> toJson({ValueSerializer? serializer}) {
    serializer ??= driftRuntimeOptions.defaultSerializer;
    return <String, dynamic>{
      'workspaceId': serializer.toJson<String>(workspaceId),
      'peonId': serializer.toJson<String>(peonId),
      'sessionId': serializer.toJson<String>(sessionId),
      'itemId': serializer.toJson<String>(itemId),
      'payloadJson': serializer.toJson<String>(payloadJson),
      'orderKey': serializer.toJson<int>(orderKey),
      'syncedAt': serializer.toJson<double>(syncedAt),
    };
  }

  CachedQueuedFollowup copyWith({
    String? workspaceId,
    String? peonId,
    String? sessionId,
    String? itemId,
    String? payloadJson,
    int? orderKey,
    double? syncedAt,
  }) => CachedQueuedFollowup(
    workspaceId: workspaceId ?? this.workspaceId,
    peonId: peonId ?? this.peonId,
    sessionId: sessionId ?? this.sessionId,
    itemId: itemId ?? this.itemId,
    payloadJson: payloadJson ?? this.payloadJson,
    orderKey: orderKey ?? this.orderKey,
    syncedAt: syncedAt ?? this.syncedAt,
  );
  CachedQueuedFollowup copyWithCompanion(CachedQueuedFollowupsCompanion data) {
    return CachedQueuedFollowup(
      workspaceId: data.workspaceId.present
          ? data.workspaceId.value
          : this.workspaceId,
      peonId: data.peonId.present ? data.peonId.value : this.peonId,
      sessionId: data.sessionId.present ? data.sessionId.value : this.sessionId,
      itemId: data.itemId.present ? data.itemId.value : this.itemId,
      payloadJson: data.payloadJson.present
          ? data.payloadJson.value
          : this.payloadJson,
      orderKey: data.orderKey.present ? data.orderKey.value : this.orderKey,
      syncedAt: data.syncedAt.present ? data.syncedAt.value : this.syncedAt,
    );
  }

  @override
  String toString() {
    return (StringBuffer('CachedQueuedFollowup(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('itemId: $itemId, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('orderKey: $orderKey, ')
          ..write('syncedAt: $syncedAt')
          ..write(')'))
        .toString();
  }

  @override
  int get hashCode => Object.hash(
    workspaceId,
    peonId,
    sessionId,
    itemId,
    payloadJson,
    orderKey,
    syncedAt,
  );
  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      (other is CachedQueuedFollowup &&
          other.workspaceId == this.workspaceId &&
          other.peonId == this.peonId &&
          other.sessionId == this.sessionId &&
          other.itemId == this.itemId &&
          other.payloadJson == this.payloadJson &&
          other.orderKey == this.orderKey &&
          other.syncedAt == this.syncedAt);
}

class CachedQueuedFollowupsCompanion
    extends UpdateCompanion<CachedQueuedFollowup> {
  final Value<String> workspaceId;
  final Value<String> peonId;
  final Value<String> sessionId;
  final Value<String> itemId;
  final Value<String> payloadJson;
  final Value<int> orderKey;
  final Value<double> syncedAt;
  final Value<int> rowid;
  const CachedQueuedFollowupsCompanion({
    this.workspaceId = const Value.absent(),
    this.peonId = const Value.absent(),
    this.sessionId = const Value.absent(),
    this.itemId = const Value.absent(),
    this.payloadJson = const Value.absent(),
    this.orderKey = const Value.absent(),
    this.syncedAt = const Value.absent(),
    this.rowid = const Value.absent(),
  });
  CachedQueuedFollowupsCompanion.insert({
    required String workspaceId,
    required String peonId,
    required String sessionId,
    required String itemId,
    required String payloadJson,
    required int orderKey,
    required double syncedAt,
    this.rowid = const Value.absent(),
  }) : workspaceId = Value(workspaceId),
       peonId = Value(peonId),
       sessionId = Value(sessionId),
       itemId = Value(itemId),
       payloadJson = Value(payloadJson),
       orderKey = Value(orderKey),
       syncedAt = Value(syncedAt);
  static Insertable<CachedQueuedFollowup> custom({
    Expression<String>? workspaceId,
    Expression<String>? peonId,
    Expression<String>? sessionId,
    Expression<String>? itemId,
    Expression<String>? payloadJson,
    Expression<int>? orderKey,
    Expression<double>? syncedAt,
    Expression<int>? rowid,
  }) {
    return RawValuesInsertable({
      if (workspaceId != null) 'workspace_id': workspaceId,
      if (peonId != null) 'peon_id': peonId,
      if (sessionId != null) 'session_id': sessionId,
      if (itemId != null) 'item_id': itemId,
      if (payloadJson != null) 'payload_json': payloadJson,
      if (orderKey != null) 'order_key': orderKey,
      if (syncedAt != null) 'synced_at': syncedAt,
      if (rowid != null) 'rowid': rowid,
    });
  }

  CachedQueuedFollowupsCompanion copyWith({
    Value<String>? workspaceId,
    Value<String>? peonId,
    Value<String>? sessionId,
    Value<String>? itemId,
    Value<String>? payloadJson,
    Value<int>? orderKey,
    Value<double>? syncedAt,
    Value<int>? rowid,
  }) {
    return CachedQueuedFollowupsCompanion(
      workspaceId: workspaceId ?? this.workspaceId,
      peonId: peonId ?? this.peonId,
      sessionId: sessionId ?? this.sessionId,
      itemId: itemId ?? this.itemId,
      payloadJson: payloadJson ?? this.payloadJson,
      orderKey: orderKey ?? this.orderKey,
      syncedAt: syncedAt ?? this.syncedAt,
      rowid: rowid ?? this.rowid,
    );
  }

  @override
  Map<String, Expression> toColumns(bool nullToAbsent) {
    final map = <String, Expression>{};
    if (workspaceId.present) {
      map['workspace_id'] = Variable<String>(workspaceId.value);
    }
    if (peonId.present) {
      map['peon_id'] = Variable<String>(peonId.value);
    }
    if (sessionId.present) {
      map['session_id'] = Variable<String>(sessionId.value);
    }
    if (itemId.present) {
      map['item_id'] = Variable<String>(itemId.value);
    }
    if (payloadJson.present) {
      map['payload_json'] = Variable<String>(payloadJson.value);
    }
    if (orderKey.present) {
      map['order_key'] = Variable<int>(orderKey.value);
    }
    if (syncedAt.present) {
      map['synced_at'] = Variable<double>(syncedAt.value);
    }
    if (rowid.present) {
      map['rowid'] = Variable<int>(rowid.value);
    }
    return map;
  }

  @override
  String toString() {
    return (StringBuffer('CachedQueuedFollowupsCompanion(')
          ..write('workspaceId: $workspaceId, ')
          ..write('peonId: $peonId, ')
          ..write('sessionId: $sessionId, ')
          ..write('itemId: $itemId, ')
          ..write('payloadJson: $payloadJson, ')
          ..write('orderKey: $orderKey, ')
          ..write('syncedAt: $syncedAt, ')
          ..write('rowid: $rowid')
          ..write(')'))
        .toString();
  }
}

abstract class _$AppDatabase extends GeneratedDatabase {
  _$AppDatabase(QueryExecutor e) : super(e);
  $AppDatabaseManager get managers => $AppDatabaseManager(this);
  late final $CachedSessionsTable cachedSessions = $CachedSessionsTable(this);
  late final $CachedWorkspacesTable cachedWorkspaces = $CachedWorkspacesTable(
    this,
  );
  late final $CachedFleetPeonsTable cachedFleetPeons = $CachedFleetPeonsTable(
    this,
  );
  late final $CachedProjectsTable cachedProjects = $CachedProjectsTable(this);
  late final $CachedAiStatsTable cachedAiStats = $CachedAiStatsTable(this);
  late final $CachedPeonManagementTable cachedPeonManagement =
      $CachedPeonManagementTable(this);
  late final $LiveCursorsTable liveCursors = $LiveCursorsTable(this);
  late final $CachedTranscriptEventsTable cachedTranscriptEvents =
      $CachedTranscriptEventsTable(this);
  late final $CachedTranscriptsTable cachedTranscripts =
      $CachedTranscriptsTable(this);
  late final $ComposerDraftsTable composerDrafts = $ComposerDraftsTable(this);
  late final $PendingFollowupCommandsTable pendingFollowupCommands =
      $PendingFollowupCommandsTable(this);
  late final $CachedQueuedFollowupsTable cachedQueuedFollowups =
      $CachedQueuedFollowupsTable(this);
  @override
  Iterable<TableInfo<Table, Object?>> get allTables =>
      allSchemaEntities.whereType<TableInfo<Table, Object?>>();
  @override
  List<DatabaseSchemaEntity> get allSchemaEntities => [
    cachedSessions,
    cachedWorkspaces,
    cachedFleetPeons,
    cachedProjects,
    cachedAiStats,
    cachedPeonManagement,
    liveCursors,
    cachedTranscriptEvents,
    cachedTranscripts,
    composerDrafts,
    pendingFollowupCommands,
    cachedQueuedFollowups,
  ];
}

typedef $$CachedSessionsTableCreateCompanionBuilder =
    CachedSessionsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String sessionId,
      Value<String?> status,
      Value<String?> projectKey,
      Value<String?> projectId,
      Value<String?> title,
      Value<String?> promptPreview,
      Value<String?> preview,
      Value<String?> author,
      Value<String?> outcomeJson,
      Value<double?> startedAt,
      Value<double?> endedAt,
      Value<double?> lastActivityAt,
      required double syncedAt,
      Value<bool> attentionUnread,
      Value<double> attentionUpdatedAt,
      Value<int> rowid,
    });
typedef $$CachedSessionsTableUpdateCompanionBuilder =
    CachedSessionsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> sessionId,
      Value<String?> status,
      Value<String?> projectKey,
      Value<String?> projectId,
      Value<String?> title,
      Value<String?> promptPreview,
      Value<String?> preview,
      Value<String?> author,
      Value<String?> outcomeJson,
      Value<double?> startedAt,
      Value<double?> endedAt,
      Value<double?> lastActivityAt,
      Value<double> syncedAt,
      Value<bool> attentionUnread,
      Value<double> attentionUpdatedAt,
      Value<int> rowid,
    });

class $$CachedSessionsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedSessionsTable> {
  $$CachedSessionsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get projectKey => $composableBuilder(
    column: $table.projectKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get projectId => $composableBuilder(
    column: $table.projectId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get promptPreview => $composableBuilder(
    column: $table.promptPreview,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get preview => $composableBuilder(
    column: $table.preview,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get author => $composableBuilder(
    column: $table.author,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get outcomeJson => $composableBuilder(
    column: $table.outcomeJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get startedAt => $composableBuilder(
    column: $table.startedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get endedAt => $composableBuilder(
    column: $table.endedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get lastActivityAt => $composableBuilder(
    column: $table.lastActivityAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get attentionUnread => $composableBuilder(
    column: $table.attentionUnread,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get attentionUpdatedAt => $composableBuilder(
    column: $table.attentionUpdatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedSessionsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedSessionsTable> {
  $$CachedSessionsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get status => $composableBuilder(
    column: $table.status,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get projectKey => $composableBuilder(
    column: $table.projectKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get projectId => $composableBuilder(
    column: $table.projectId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get title => $composableBuilder(
    column: $table.title,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get promptPreview => $composableBuilder(
    column: $table.promptPreview,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get preview => $composableBuilder(
    column: $table.preview,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get author => $composableBuilder(
    column: $table.author,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get outcomeJson => $composableBuilder(
    column: $table.outcomeJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get startedAt => $composableBuilder(
    column: $table.startedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get endedAt => $composableBuilder(
    column: $table.endedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get lastActivityAt => $composableBuilder(
    column: $table.lastActivityAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get attentionUnread => $composableBuilder(
    column: $table.attentionUnread,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get attentionUpdatedAt => $composableBuilder(
    column: $table.attentionUpdatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedSessionsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedSessionsTable> {
  $$CachedSessionsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get status =>
      $composableBuilder(column: $table.status, builder: (column) => column);

  GeneratedColumn<String> get projectKey => $composableBuilder(
    column: $table.projectKey,
    builder: (column) => column,
  );

  GeneratedColumn<String> get projectId =>
      $composableBuilder(column: $table.projectId, builder: (column) => column);

  GeneratedColumn<String> get title =>
      $composableBuilder(column: $table.title, builder: (column) => column);

  GeneratedColumn<String> get promptPreview => $composableBuilder(
    column: $table.promptPreview,
    builder: (column) => column,
  );

  GeneratedColumn<String> get preview =>
      $composableBuilder(column: $table.preview, builder: (column) => column);

  GeneratedColumn<String> get author =>
      $composableBuilder(column: $table.author, builder: (column) => column);

  GeneratedColumn<String> get outcomeJson => $composableBuilder(
    column: $table.outcomeJson,
    builder: (column) => column,
  );

  GeneratedColumn<double> get startedAt =>
      $composableBuilder(column: $table.startedAt, builder: (column) => column);

  GeneratedColumn<double> get endedAt =>
      $composableBuilder(column: $table.endedAt, builder: (column) => column);

  GeneratedColumn<double> get lastActivityAt => $composableBuilder(
    column: $table.lastActivityAt,
    builder: (column) => column,
  );

  GeneratedColumn<double> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);

  GeneratedColumn<bool> get attentionUnread => $composableBuilder(
    column: $table.attentionUnread,
    builder: (column) => column,
  );

  GeneratedColumn<double> get attentionUpdatedAt => $composableBuilder(
    column: $table.attentionUpdatedAt,
    builder: (column) => column,
  );
}

class $$CachedSessionsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedSessionsTable,
          CachedSession,
          $$CachedSessionsTableFilterComposer,
          $$CachedSessionsTableOrderingComposer,
          $$CachedSessionsTableAnnotationComposer,
          $$CachedSessionsTableCreateCompanionBuilder,
          $$CachedSessionsTableUpdateCompanionBuilder,
          (
            CachedSession,
            BaseReferences<_$AppDatabase, $CachedSessionsTable, CachedSession>,
          ),
          CachedSession,
          PrefetchHooks Function()
        > {
  $$CachedSessionsTableTableManager(
    _$AppDatabase db,
    $CachedSessionsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedSessionsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedSessionsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedSessionsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String?> status = const Value.absent(),
                Value<String?> projectKey = const Value.absent(),
                Value<String?> projectId = const Value.absent(),
                Value<String?> title = const Value.absent(),
                Value<String?> promptPreview = const Value.absent(),
                Value<String?> preview = const Value.absent(),
                Value<String?> author = const Value.absent(),
                Value<String?> outcomeJson = const Value.absent(),
                Value<double?> startedAt = const Value.absent(),
                Value<double?> endedAt = const Value.absent(),
                Value<double?> lastActivityAt = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<bool> attentionUnread = const Value.absent(),
                Value<double> attentionUpdatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedSessionsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                status: status,
                projectKey: projectKey,
                projectId: projectId,
                title: title,
                promptPreview: promptPreview,
                preview: preview,
                author: author,
                outcomeJson: outcomeJson,
                startedAt: startedAt,
                endedAt: endedAt,
                lastActivityAt: lastActivityAt,
                syncedAt: syncedAt,
                attentionUnread: attentionUnread,
                attentionUpdatedAt: attentionUpdatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String sessionId,
                Value<String?> status = const Value.absent(),
                Value<String?> projectKey = const Value.absent(),
                Value<String?> projectId = const Value.absent(),
                Value<String?> title = const Value.absent(),
                Value<String?> promptPreview = const Value.absent(),
                Value<String?> preview = const Value.absent(),
                Value<String?> author = const Value.absent(),
                Value<String?> outcomeJson = const Value.absent(),
                Value<double?> startedAt = const Value.absent(),
                Value<double?> endedAt = const Value.absent(),
                Value<double?> lastActivityAt = const Value.absent(),
                required double syncedAt,
                Value<bool> attentionUnread = const Value.absent(),
                Value<double> attentionUpdatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedSessionsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                status: status,
                projectKey: projectKey,
                projectId: projectId,
                title: title,
                promptPreview: promptPreview,
                preview: preview,
                author: author,
                outcomeJson: outcomeJson,
                startedAt: startedAt,
                endedAt: endedAt,
                lastActivityAt: lastActivityAt,
                syncedAt: syncedAt,
                attentionUnread: attentionUnread,
                attentionUpdatedAt: attentionUpdatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedSessionsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedSessionsTable,
      CachedSession,
      $$CachedSessionsTableFilterComposer,
      $$CachedSessionsTableOrderingComposer,
      $$CachedSessionsTableAnnotationComposer,
      $$CachedSessionsTableCreateCompanionBuilder,
      $$CachedSessionsTableUpdateCompanionBuilder,
      (
        CachedSession,
        BaseReferences<_$AppDatabase, $CachedSessionsTable, CachedSession>,
      ),
      CachedSession,
      PrefetchHooks Function()
    >;
typedef $$CachedWorkspacesTableCreateCompanionBuilder =
    CachedWorkspacesCompanion Function({
      required String workspaceId,
      required String name,
      Value<String?> role,
      required double syncedAt,
      Value<int> rowid,
    });
typedef $$CachedWorkspacesTableUpdateCompanionBuilder =
    CachedWorkspacesCompanion Function({
      Value<String> workspaceId,
      Value<String> name,
      Value<String?> role,
      Value<double> syncedAt,
      Value<int> rowid,
    });

class $$CachedWorkspacesTableFilterComposer
    extends Composer<_$AppDatabase, $CachedWorkspacesTable> {
  $$CachedWorkspacesTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get role => $composableBuilder(
    column: $table.role,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedWorkspacesTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedWorkspacesTable> {
  $$CachedWorkspacesTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get role => $composableBuilder(
    column: $table.role,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedWorkspacesTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedWorkspacesTable> {
  $$CachedWorkspacesTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get role =>
      $composableBuilder(column: $table.role, builder: (column) => column);

  GeneratedColumn<double> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);
}

class $$CachedWorkspacesTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedWorkspacesTable,
          CachedWorkspace,
          $$CachedWorkspacesTableFilterComposer,
          $$CachedWorkspacesTableOrderingComposer,
          $$CachedWorkspacesTableAnnotationComposer,
          $$CachedWorkspacesTableCreateCompanionBuilder,
          $$CachedWorkspacesTableUpdateCompanionBuilder,
          (
            CachedWorkspace,
            BaseReferences<
              _$AppDatabase,
              $CachedWorkspacesTable,
              CachedWorkspace
            >,
          ),
          CachedWorkspace,
          PrefetchHooks Function()
        > {
  $$CachedWorkspacesTableTableManager(
    _$AppDatabase db,
    $CachedWorkspacesTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedWorkspacesTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedWorkspacesTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedWorkspacesTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> name = const Value.absent(),
                Value<String?> role = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedWorkspacesCompanion(
                workspaceId: workspaceId,
                name: name,
                role: role,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String name,
                Value<String?> role = const Value.absent(),
                required double syncedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedWorkspacesCompanion.insert(
                workspaceId: workspaceId,
                name: name,
                role: role,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedWorkspacesTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedWorkspacesTable,
      CachedWorkspace,
      $$CachedWorkspacesTableFilterComposer,
      $$CachedWorkspacesTableOrderingComposer,
      $$CachedWorkspacesTableAnnotationComposer,
      $$CachedWorkspacesTableCreateCompanionBuilder,
      $$CachedWorkspacesTableUpdateCompanionBuilder,
      (
        CachedWorkspace,
        BaseReferences<_$AppDatabase, $CachedWorkspacesTable, CachedWorkspace>,
      ),
      CachedWorkspace,
      PrefetchHooks Function()
    >;
typedef $$CachedFleetPeonsTableCreateCompanionBuilder =
    CachedFleetPeonsCompanion Function({
      required String workspaceId,
      required String peonId,
      Value<String?> name,
      Value<String?> hostname,
      Value<String?> baseUrl,
      Value<String?> addressSource,
      required bool online,
      required double lastSeen,
      Value<String> capabilitiesJson,
      Value<int?> activeSessions,
      Value<bool?> paused,
      required double syncedAt,
      Value<int> rowid,
    });
typedef $$CachedFleetPeonsTableUpdateCompanionBuilder =
    CachedFleetPeonsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String?> name,
      Value<String?> hostname,
      Value<String?> baseUrl,
      Value<String?> addressSource,
      Value<bool> online,
      Value<double> lastSeen,
      Value<String> capabilitiesJson,
      Value<int?> activeSessions,
      Value<bool?> paused,
      Value<double> syncedAt,
      Value<int> rowid,
    });

class $$CachedFleetPeonsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedFleetPeonsTable> {
  $$CachedFleetPeonsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get hostname => $composableBuilder(
    column: $table.hostname,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get baseUrl => $composableBuilder(
    column: $table.baseUrl,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get addressSource => $composableBuilder(
    column: $table.addressSource,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get online => $composableBuilder(
    column: $table.online,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get lastSeen => $composableBuilder(
    column: $table.lastSeen,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get capabilitiesJson => $composableBuilder(
    column: $table.capabilitiesJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get activeSessions => $composableBuilder(
    column: $table.activeSessions,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get paused => $composableBuilder(
    column: $table.paused,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedFleetPeonsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedFleetPeonsTable> {
  $$CachedFleetPeonsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get hostname => $composableBuilder(
    column: $table.hostname,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get baseUrl => $composableBuilder(
    column: $table.baseUrl,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get addressSource => $composableBuilder(
    column: $table.addressSource,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get online => $composableBuilder(
    column: $table.online,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get lastSeen => $composableBuilder(
    column: $table.lastSeen,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get capabilitiesJson => $composableBuilder(
    column: $table.capabilitiesJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get activeSessions => $composableBuilder(
    column: $table.activeSessions,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get paused => $composableBuilder(
    column: $table.paused,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedFleetPeonsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedFleetPeonsTable> {
  $$CachedFleetPeonsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get hostname =>
      $composableBuilder(column: $table.hostname, builder: (column) => column);

  GeneratedColumn<String> get baseUrl =>
      $composableBuilder(column: $table.baseUrl, builder: (column) => column);

  GeneratedColumn<String> get addressSource => $composableBuilder(
    column: $table.addressSource,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get online =>
      $composableBuilder(column: $table.online, builder: (column) => column);

  GeneratedColumn<double> get lastSeen =>
      $composableBuilder(column: $table.lastSeen, builder: (column) => column);

  GeneratedColumn<String> get capabilitiesJson => $composableBuilder(
    column: $table.capabilitiesJson,
    builder: (column) => column,
  );

  GeneratedColumn<int> get activeSessions => $composableBuilder(
    column: $table.activeSessions,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get paused =>
      $composableBuilder(column: $table.paused, builder: (column) => column);

  GeneratedColumn<double> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);
}

class $$CachedFleetPeonsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedFleetPeonsTable,
          CachedFleetPeon,
          $$CachedFleetPeonsTableFilterComposer,
          $$CachedFleetPeonsTableOrderingComposer,
          $$CachedFleetPeonsTableAnnotationComposer,
          $$CachedFleetPeonsTableCreateCompanionBuilder,
          $$CachedFleetPeonsTableUpdateCompanionBuilder,
          (
            CachedFleetPeon,
            BaseReferences<
              _$AppDatabase,
              $CachedFleetPeonsTable,
              CachedFleetPeon
            >,
          ),
          CachedFleetPeon,
          PrefetchHooks Function()
        > {
  $$CachedFleetPeonsTableTableManager(
    _$AppDatabase db,
    $CachedFleetPeonsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedFleetPeonsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedFleetPeonsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedFleetPeonsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String?> name = const Value.absent(),
                Value<String?> hostname = const Value.absent(),
                Value<String?> baseUrl = const Value.absent(),
                Value<String?> addressSource = const Value.absent(),
                Value<bool> online = const Value.absent(),
                Value<double> lastSeen = const Value.absent(),
                Value<String> capabilitiesJson = const Value.absent(),
                Value<int?> activeSessions = const Value.absent(),
                Value<bool?> paused = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedFleetPeonsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                name: name,
                hostname: hostname,
                baseUrl: baseUrl,
                addressSource: addressSource,
                online: online,
                lastSeen: lastSeen,
                capabilitiesJson: capabilitiesJson,
                activeSessions: activeSessions,
                paused: paused,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                Value<String?> name = const Value.absent(),
                Value<String?> hostname = const Value.absent(),
                Value<String?> baseUrl = const Value.absent(),
                Value<String?> addressSource = const Value.absent(),
                required bool online,
                required double lastSeen,
                Value<String> capabilitiesJson = const Value.absent(),
                Value<int?> activeSessions = const Value.absent(),
                Value<bool?> paused = const Value.absent(),
                required double syncedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedFleetPeonsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                name: name,
                hostname: hostname,
                baseUrl: baseUrl,
                addressSource: addressSource,
                online: online,
                lastSeen: lastSeen,
                capabilitiesJson: capabilitiesJson,
                activeSessions: activeSessions,
                paused: paused,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedFleetPeonsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedFleetPeonsTable,
      CachedFleetPeon,
      $$CachedFleetPeonsTableFilterComposer,
      $$CachedFleetPeonsTableOrderingComposer,
      $$CachedFleetPeonsTableAnnotationComposer,
      $$CachedFleetPeonsTableCreateCompanionBuilder,
      $$CachedFleetPeonsTableUpdateCompanionBuilder,
      (
        CachedFleetPeon,
        BaseReferences<_$AppDatabase, $CachedFleetPeonsTable, CachedFleetPeon>,
      ),
      CachedFleetPeon,
      PrefetchHooks Function()
    >;
typedef $$CachedProjectsTableCreateCompanionBuilder =
    CachedProjectsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String projectId,
      required String projectKey,
      Value<String?> name,
      Value<String?> dir,
      Value<String?> metadata,
      Value<int> sessionCount,
      Value<int> memberCount,
      Value<int> activeCount,
      Value<double?> lastActivityMs,
      Value<double> syncedAt,
      Value<bool> deleted,
      Value<int> rowid,
    });
typedef $$CachedProjectsTableUpdateCompanionBuilder =
    CachedProjectsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> projectId,
      Value<String> projectKey,
      Value<String?> name,
      Value<String?> dir,
      Value<String?> metadata,
      Value<int> sessionCount,
      Value<int> memberCount,
      Value<int> activeCount,
      Value<double?> lastActivityMs,
      Value<double> syncedAt,
      Value<bool> deleted,
      Value<int> rowid,
    });

class $$CachedProjectsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedProjectsTable> {
  $$CachedProjectsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get projectId => $composableBuilder(
    column: $table.projectId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get projectKey => $composableBuilder(
    column: $table.projectKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get dir => $composableBuilder(
    column: $table.dir,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get metadata => $composableBuilder(
    column: $table.metadata,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get sessionCount => $composableBuilder(
    column: $table.sessionCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get memberCount => $composableBuilder(
    column: $table.memberCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get activeCount => $composableBuilder(
    column: $table.activeCount,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get lastActivityMs => $composableBuilder(
    column: $table.lastActivityMs,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get deleted => $composableBuilder(
    column: $table.deleted,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedProjectsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedProjectsTable> {
  $$CachedProjectsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get projectId => $composableBuilder(
    column: $table.projectId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get projectKey => $composableBuilder(
    column: $table.projectKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get name => $composableBuilder(
    column: $table.name,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get dir => $composableBuilder(
    column: $table.dir,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get metadata => $composableBuilder(
    column: $table.metadata,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get sessionCount => $composableBuilder(
    column: $table.sessionCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get memberCount => $composableBuilder(
    column: $table.memberCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get activeCount => $composableBuilder(
    column: $table.activeCount,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get lastActivityMs => $composableBuilder(
    column: $table.lastActivityMs,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get deleted => $composableBuilder(
    column: $table.deleted,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedProjectsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedProjectsTable> {
  $$CachedProjectsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get projectId =>
      $composableBuilder(column: $table.projectId, builder: (column) => column);

  GeneratedColumn<String> get projectKey => $composableBuilder(
    column: $table.projectKey,
    builder: (column) => column,
  );

  GeneratedColumn<String> get name =>
      $composableBuilder(column: $table.name, builder: (column) => column);

  GeneratedColumn<String> get dir =>
      $composableBuilder(column: $table.dir, builder: (column) => column);

  GeneratedColumn<String> get metadata =>
      $composableBuilder(column: $table.metadata, builder: (column) => column);

  GeneratedColumn<int> get sessionCount => $composableBuilder(
    column: $table.sessionCount,
    builder: (column) => column,
  );

  GeneratedColumn<int> get memberCount => $composableBuilder(
    column: $table.memberCount,
    builder: (column) => column,
  );

  GeneratedColumn<int> get activeCount => $composableBuilder(
    column: $table.activeCount,
    builder: (column) => column,
  );

  GeneratedColumn<double> get lastActivityMs => $composableBuilder(
    column: $table.lastActivityMs,
    builder: (column) => column,
  );

  GeneratedColumn<double> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);

  GeneratedColumn<bool> get deleted =>
      $composableBuilder(column: $table.deleted, builder: (column) => column);
}

class $$CachedProjectsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedProjectsTable,
          CachedProject,
          $$CachedProjectsTableFilterComposer,
          $$CachedProjectsTableOrderingComposer,
          $$CachedProjectsTableAnnotationComposer,
          $$CachedProjectsTableCreateCompanionBuilder,
          $$CachedProjectsTableUpdateCompanionBuilder,
          (
            CachedProject,
            BaseReferences<_$AppDatabase, $CachedProjectsTable, CachedProject>,
          ),
          CachedProject,
          PrefetchHooks Function()
        > {
  $$CachedProjectsTableTableManager(
    _$AppDatabase db,
    $CachedProjectsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedProjectsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedProjectsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedProjectsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> projectId = const Value.absent(),
                Value<String> projectKey = const Value.absent(),
                Value<String?> name = const Value.absent(),
                Value<String?> dir = const Value.absent(),
                Value<String?> metadata = const Value.absent(),
                Value<int> sessionCount = const Value.absent(),
                Value<int> memberCount = const Value.absent(),
                Value<int> activeCount = const Value.absent(),
                Value<double?> lastActivityMs = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<bool> deleted = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedProjectsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                projectId: projectId,
                projectKey: projectKey,
                name: name,
                dir: dir,
                metadata: metadata,
                sessionCount: sessionCount,
                memberCount: memberCount,
                activeCount: activeCount,
                lastActivityMs: lastActivityMs,
                syncedAt: syncedAt,
                deleted: deleted,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String projectId,
                required String projectKey,
                Value<String?> name = const Value.absent(),
                Value<String?> dir = const Value.absent(),
                Value<String?> metadata = const Value.absent(),
                Value<int> sessionCount = const Value.absent(),
                Value<int> memberCount = const Value.absent(),
                Value<int> activeCount = const Value.absent(),
                Value<double?> lastActivityMs = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<bool> deleted = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedProjectsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                projectId: projectId,
                projectKey: projectKey,
                name: name,
                dir: dir,
                metadata: metadata,
                sessionCount: sessionCount,
                memberCount: memberCount,
                activeCount: activeCount,
                lastActivityMs: lastActivityMs,
                syncedAt: syncedAt,
                deleted: deleted,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedProjectsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedProjectsTable,
      CachedProject,
      $$CachedProjectsTableFilterComposer,
      $$CachedProjectsTableOrderingComposer,
      $$CachedProjectsTableAnnotationComposer,
      $$CachedProjectsTableCreateCompanionBuilder,
      $$CachedProjectsTableUpdateCompanionBuilder,
      (
        CachedProject,
        BaseReferences<_$AppDatabase, $CachedProjectsTable, CachedProject>,
      ),
      CachedProject,
      PrefetchHooks Function()
    >;
typedef $$CachedAiStatsTableCreateCompanionBuilder =
    CachedAiStatsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String period,
      required String payloadJson,
      required double updatedAt,
      Value<int> rowid,
    });
typedef $$CachedAiStatsTableUpdateCompanionBuilder =
    CachedAiStatsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> period,
      Value<String> payloadJson,
      Value<double> updatedAt,
      Value<int> rowid,
    });

class $$CachedAiStatsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedAiStatsTable> {
  $$CachedAiStatsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get period => $composableBuilder(
    column: $table.period,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedAiStatsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedAiStatsTable> {
  $$CachedAiStatsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get period => $composableBuilder(
    column: $table.period,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedAiStatsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedAiStatsTable> {
  $$CachedAiStatsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get period =>
      $composableBuilder(column: $table.period, builder: (column) => column);

  GeneratedColumn<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => column,
  );

  GeneratedColumn<double> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$CachedAiStatsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedAiStatsTable,
          CachedAiStat,
          $$CachedAiStatsTableFilterComposer,
          $$CachedAiStatsTableOrderingComposer,
          $$CachedAiStatsTableAnnotationComposer,
          $$CachedAiStatsTableCreateCompanionBuilder,
          $$CachedAiStatsTableUpdateCompanionBuilder,
          (
            CachedAiStat,
            BaseReferences<_$AppDatabase, $CachedAiStatsTable, CachedAiStat>,
          ),
          CachedAiStat,
          PrefetchHooks Function()
        > {
  $$CachedAiStatsTableTableManager(_$AppDatabase db, $CachedAiStatsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedAiStatsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedAiStatsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedAiStatsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> period = const Value.absent(),
                Value<String> payloadJson = const Value.absent(),
                Value<double> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedAiStatsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                period: period,
                payloadJson: payloadJson,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String period,
                required String payloadJson,
                required double updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedAiStatsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                period: period,
                payloadJson: payloadJson,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedAiStatsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedAiStatsTable,
      CachedAiStat,
      $$CachedAiStatsTableFilterComposer,
      $$CachedAiStatsTableOrderingComposer,
      $$CachedAiStatsTableAnnotationComposer,
      $$CachedAiStatsTableCreateCompanionBuilder,
      $$CachedAiStatsTableUpdateCompanionBuilder,
      (
        CachedAiStat,
        BaseReferences<_$AppDatabase, $CachedAiStatsTable, CachedAiStat>,
      ),
      CachedAiStat,
      PrefetchHooks Function()
    >;
typedef $$CachedPeonManagementTableCreateCompanionBuilder =
    CachedPeonManagementCompanion Function({
      required String workspaceId,
      required String peonId,
      required String kind,
      required String payloadJson,
      required double updatedAt,
      Value<int> rowid,
    });
typedef $$CachedPeonManagementTableUpdateCompanionBuilder =
    CachedPeonManagementCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> kind,
      Value<String> payloadJson,
      Value<double> updatedAt,
      Value<int> rowid,
    });

class $$CachedPeonManagementTableFilterComposer
    extends Composer<_$AppDatabase, $CachedPeonManagementTable> {
  $$CachedPeonManagementTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedPeonManagementTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedPeonManagementTable> {
  $$CachedPeonManagementTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get kind => $composableBuilder(
    column: $table.kind,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedPeonManagementTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedPeonManagementTable> {
  $$CachedPeonManagementTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get kind =>
      $composableBuilder(column: $table.kind, builder: (column) => column);

  GeneratedColumn<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => column,
  );

  GeneratedColumn<double> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$CachedPeonManagementTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedPeonManagementTable,
          CachedPeonManagementData,
          $$CachedPeonManagementTableFilterComposer,
          $$CachedPeonManagementTableOrderingComposer,
          $$CachedPeonManagementTableAnnotationComposer,
          $$CachedPeonManagementTableCreateCompanionBuilder,
          $$CachedPeonManagementTableUpdateCompanionBuilder,
          (
            CachedPeonManagementData,
            BaseReferences<
              _$AppDatabase,
              $CachedPeonManagementTable,
              CachedPeonManagementData
            >,
          ),
          CachedPeonManagementData,
          PrefetchHooks Function()
        > {
  $$CachedPeonManagementTableTableManager(
    _$AppDatabase db,
    $CachedPeonManagementTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedPeonManagementTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedPeonManagementTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$CachedPeonManagementTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> kind = const Value.absent(),
                Value<String> payloadJson = const Value.absent(),
                Value<double> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedPeonManagementCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                kind: kind,
                payloadJson: payloadJson,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String kind,
                required String payloadJson,
                required double updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedPeonManagementCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                kind: kind,
                payloadJson: payloadJson,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedPeonManagementTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedPeonManagementTable,
      CachedPeonManagementData,
      $$CachedPeonManagementTableFilterComposer,
      $$CachedPeonManagementTableOrderingComposer,
      $$CachedPeonManagementTableAnnotationComposer,
      $$CachedPeonManagementTableCreateCompanionBuilder,
      $$CachedPeonManagementTableUpdateCompanionBuilder,
      (
        CachedPeonManagementData,
        BaseReferences<
          _$AppDatabase,
          $CachedPeonManagementTable,
          CachedPeonManagementData
        >,
      ),
      CachedPeonManagementData,
      PrefetchHooks Function()
    >;
typedef $$LiveCursorsTableCreateCompanionBuilder =
    LiveCursorsCompanion Function({
      required String workspaceId,
      Value<int> cursor,
      Value<int> rowid,
    });
typedef $$LiveCursorsTableUpdateCompanionBuilder =
    LiveCursorsCompanion Function({
      Value<String> workspaceId,
      Value<int> cursor,
      Value<int> rowid,
    });

class $$LiveCursorsTableFilterComposer
    extends Composer<_$AppDatabase, $LiveCursorsTable> {
  $$LiveCursorsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnFilters(column),
  );
}

class $$LiveCursorsTableOrderingComposer
    extends Composer<_$AppDatabase, $LiveCursorsTable> {
  $$LiveCursorsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get cursor => $composableBuilder(
    column: $table.cursor,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$LiveCursorsTableAnnotationComposer
    extends Composer<_$AppDatabase, $LiveCursorsTable> {
  $$LiveCursorsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<int> get cursor =>
      $composableBuilder(column: $table.cursor, builder: (column) => column);
}

class $$LiveCursorsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $LiveCursorsTable,
          LiveCursor,
          $$LiveCursorsTableFilterComposer,
          $$LiveCursorsTableOrderingComposer,
          $$LiveCursorsTableAnnotationComposer,
          $$LiveCursorsTableCreateCompanionBuilder,
          $$LiveCursorsTableUpdateCompanionBuilder,
          (
            LiveCursor,
            BaseReferences<_$AppDatabase, $LiveCursorsTable, LiveCursor>,
          ),
          LiveCursor,
          PrefetchHooks Function()
        > {
  $$LiveCursorsTableTableManager(_$AppDatabase db, $LiveCursorsTable table)
    : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$LiveCursorsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$LiveCursorsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$LiveCursorsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<int> cursor = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LiveCursorsCompanion(
                workspaceId: workspaceId,
                cursor: cursor,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                Value<int> cursor = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => LiveCursorsCompanion.insert(
                workspaceId: workspaceId,
                cursor: cursor,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$LiveCursorsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $LiveCursorsTable,
      LiveCursor,
      $$LiveCursorsTableFilterComposer,
      $$LiveCursorsTableOrderingComposer,
      $$LiveCursorsTableAnnotationComposer,
      $$LiveCursorsTableCreateCompanionBuilder,
      $$LiveCursorsTableUpdateCompanionBuilder,
      (
        LiveCursor,
        BaseReferences<_$AppDatabase, $LiveCursorsTable, LiveCursor>,
      ),
      LiveCursor,
      PrefetchHooks Function()
    >;
typedef $$CachedTranscriptEventsTableCreateCompanionBuilder =
    CachedTranscriptEventsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String sessionId,
      required String eventId,
      required int orderKey,
      Value<String?> eventType,
      required String payloadJson,
      Value<double?> createdAt,
      required double updatedAt,
      Value<int> rowid,
    });
typedef $$CachedTranscriptEventsTableUpdateCompanionBuilder =
    CachedTranscriptEventsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> sessionId,
      Value<String> eventId,
      Value<int> orderKey,
      Value<String?> eventType,
      Value<String> payloadJson,
      Value<double?> createdAt,
      Value<double> updatedAt,
      Value<int> rowid,
    });

class $$CachedTranscriptEventsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedTranscriptEventsTable> {
  $$CachedTranscriptEventsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get eventId => $composableBuilder(
    column: $table.eventId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get orderKey => $composableBuilder(
    column: $table.orderKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get eventType => $composableBuilder(
    column: $table.eventType,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedTranscriptEventsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedTranscriptEventsTable> {
  $$CachedTranscriptEventsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get eventId => $composableBuilder(
    column: $table.eventId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get orderKey => $composableBuilder(
    column: $table.orderKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get eventType => $composableBuilder(
    column: $table.eventType,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedTranscriptEventsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedTranscriptEventsTable> {
  $$CachedTranscriptEventsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get eventId =>
      $composableBuilder(column: $table.eventId, builder: (column) => column);

  GeneratedColumn<int> get orderKey =>
      $composableBuilder(column: $table.orderKey, builder: (column) => column);

  GeneratedColumn<String> get eventType =>
      $composableBuilder(column: $table.eventType, builder: (column) => column);

  GeneratedColumn<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => column,
  );

  GeneratedColumn<double> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);

  GeneratedColumn<double> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$CachedTranscriptEventsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedTranscriptEventsTable,
          CachedTranscriptEvent,
          $$CachedTranscriptEventsTableFilterComposer,
          $$CachedTranscriptEventsTableOrderingComposer,
          $$CachedTranscriptEventsTableAnnotationComposer,
          $$CachedTranscriptEventsTableCreateCompanionBuilder,
          $$CachedTranscriptEventsTableUpdateCompanionBuilder,
          (
            CachedTranscriptEvent,
            BaseReferences<
              _$AppDatabase,
              $CachedTranscriptEventsTable,
              CachedTranscriptEvent
            >,
          ),
          CachedTranscriptEvent,
          PrefetchHooks Function()
        > {
  $$CachedTranscriptEventsTableTableManager(
    _$AppDatabase db,
    $CachedTranscriptEventsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedTranscriptEventsTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$CachedTranscriptEventsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$CachedTranscriptEventsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> eventId = const Value.absent(),
                Value<int> orderKey = const Value.absent(),
                Value<String?> eventType = const Value.absent(),
                Value<String> payloadJson = const Value.absent(),
                Value<double?> createdAt = const Value.absent(),
                Value<double> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedTranscriptEventsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                eventId: eventId,
                orderKey: orderKey,
                eventType: eventType,
                payloadJson: payloadJson,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String sessionId,
                required String eventId,
                required int orderKey,
                Value<String?> eventType = const Value.absent(),
                required String payloadJson,
                Value<double?> createdAt = const Value.absent(),
                required double updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedTranscriptEventsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                eventId: eventId,
                orderKey: orderKey,
                eventType: eventType,
                payloadJson: payloadJson,
                createdAt: createdAt,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedTranscriptEventsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedTranscriptEventsTable,
      CachedTranscriptEvent,
      $$CachedTranscriptEventsTableFilterComposer,
      $$CachedTranscriptEventsTableOrderingComposer,
      $$CachedTranscriptEventsTableAnnotationComposer,
      $$CachedTranscriptEventsTableCreateCompanionBuilder,
      $$CachedTranscriptEventsTableUpdateCompanionBuilder,
      (
        CachedTranscriptEvent,
        BaseReferences<
          _$AppDatabase,
          $CachedTranscriptEventsTable,
          CachedTranscriptEvent
        >,
      ),
      CachedTranscriptEvent,
      PrefetchHooks Function()
    >;
typedef $$CachedTranscriptsTableCreateCompanionBuilder =
    CachedTranscriptsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String sessionId,
      Value<bool> hasOlder,
      Value<double> syncedAt,
      Value<int> rowid,
    });
typedef $$CachedTranscriptsTableUpdateCompanionBuilder =
    CachedTranscriptsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> sessionId,
      Value<bool> hasOlder,
      Value<double> syncedAt,
      Value<int> rowid,
    });

class $$CachedTranscriptsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedTranscriptsTable> {
  $$CachedTranscriptsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get hasOlder => $composableBuilder(
    column: $table.hasOlder,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedTranscriptsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedTranscriptsTable> {
  $$CachedTranscriptsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get hasOlder => $composableBuilder(
    column: $table.hasOlder,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedTranscriptsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedTranscriptsTable> {
  $$CachedTranscriptsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<bool> get hasOlder =>
      $composableBuilder(column: $table.hasOlder, builder: (column) => column);

  GeneratedColumn<double> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);
}

class $$CachedTranscriptsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedTranscriptsTable,
          CachedTranscript,
          $$CachedTranscriptsTableFilterComposer,
          $$CachedTranscriptsTableOrderingComposer,
          $$CachedTranscriptsTableAnnotationComposer,
          $$CachedTranscriptsTableCreateCompanionBuilder,
          $$CachedTranscriptsTableUpdateCompanionBuilder,
          (
            CachedTranscript,
            BaseReferences<
              _$AppDatabase,
              $CachedTranscriptsTable,
              CachedTranscript
            >,
          ),
          CachedTranscript,
          PrefetchHooks Function()
        > {
  $$CachedTranscriptsTableTableManager(
    _$AppDatabase db,
    $CachedTranscriptsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedTranscriptsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$CachedTranscriptsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$CachedTranscriptsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<bool> hasOlder = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedTranscriptsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                hasOlder: hasOlder,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String sessionId,
                Value<bool> hasOlder = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedTranscriptsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                hasOlder: hasOlder,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedTranscriptsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedTranscriptsTable,
      CachedTranscript,
      $$CachedTranscriptsTableFilterComposer,
      $$CachedTranscriptsTableOrderingComposer,
      $$CachedTranscriptsTableAnnotationComposer,
      $$CachedTranscriptsTableCreateCompanionBuilder,
      $$CachedTranscriptsTableUpdateCompanionBuilder,
      (
        CachedTranscript,
        BaseReferences<
          _$AppDatabase,
          $CachedTranscriptsTable,
          CachedTranscript
        >,
      ),
      CachedTranscript,
      PrefetchHooks Function()
    >;
typedef $$ComposerDraftsTableCreateCompanionBuilder =
    ComposerDraftsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String sessionId,
      required String draftText,
      required double updatedAt,
      Value<int> rowid,
    });
typedef $$ComposerDraftsTableUpdateCompanionBuilder =
    ComposerDraftsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> sessionId,
      Value<String> draftText,
      Value<double> updatedAt,
      Value<int> rowid,
    });

class $$ComposerDraftsTableFilterComposer
    extends Composer<_$AppDatabase, $ComposerDraftsTable> {
  $$ComposerDraftsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get draftText => $composableBuilder(
    column: $table.draftText,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$ComposerDraftsTableOrderingComposer
    extends Composer<_$AppDatabase, $ComposerDraftsTable> {
  $$ComposerDraftsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get draftText => $composableBuilder(
    column: $table.draftText,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get updatedAt => $composableBuilder(
    column: $table.updatedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$ComposerDraftsTableAnnotationComposer
    extends Composer<_$AppDatabase, $ComposerDraftsTable> {
  $$ComposerDraftsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get draftText =>
      $composableBuilder(column: $table.draftText, builder: (column) => column);

  GeneratedColumn<double> get updatedAt =>
      $composableBuilder(column: $table.updatedAt, builder: (column) => column);
}

class $$ComposerDraftsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $ComposerDraftsTable,
          ComposerDraft,
          $$ComposerDraftsTableFilterComposer,
          $$ComposerDraftsTableOrderingComposer,
          $$ComposerDraftsTableAnnotationComposer,
          $$ComposerDraftsTableCreateCompanionBuilder,
          $$ComposerDraftsTableUpdateCompanionBuilder,
          (
            ComposerDraft,
            BaseReferences<_$AppDatabase, $ComposerDraftsTable, ComposerDraft>,
          ),
          ComposerDraft,
          PrefetchHooks Function()
        > {
  $$ComposerDraftsTableTableManager(
    _$AppDatabase db,
    $ComposerDraftsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$ComposerDraftsTableFilterComposer($db: db, $table: table),
          createOrderingComposer: () =>
              $$ComposerDraftsTableOrderingComposer($db: db, $table: table),
          createComputedFieldComposer: () =>
              $$ComposerDraftsTableAnnotationComposer($db: db, $table: table),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> draftText = const Value.absent(),
                Value<double> updatedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => ComposerDraftsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                draftText: draftText,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String sessionId,
                required String draftText,
                required double updatedAt,
                Value<int> rowid = const Value.absent(),
              }) => ComposerDraftsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                draftText: draftText,
                updatedAt: updatedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$ComposerDraftsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $ComposerDraftsTable,
      ComposerDraft,
      $$ComposerDraftsTableFilterComposer,
      $$ComposerDraftsTableOrderingComposer,
      $$ComposerDraftsTableAnnotationComposer,
      $$ComposerDraftsTableCreateCompanionBuilder,
      $$ComposerDraftsTableUpdateCompanionBuilder,
      (
        ComposerDraft,
        BaseReferences<_$AppDatabase, $ComposerDraftsTable, ComposerDraft>,
      ),
      ComposerDraft,
      PrefetchHooks Function()
    >;
typedef $$PendingFollowupCommandsTableCreateCompanionBuilder =
    PendingFollowupCommandsCompanion Function({
      required String commandId,
      required String workspaceId,
      required String peonId,
      required String sessionId,
      required String prompt,
      required bool serverQueue,
      Value<bool> startNow,
      Value<String?> agent,
      Value<String?> model,
      Value<String?> reasoningEffort,
      Value<String> attachmentsJson,
      required double createdAt,
      Value<int> rowid,
    });
typedef $$PendingFollowupCommandsTableUpdateCompanionBuilder =
    PendingFollowupCommandsCompanion Function({
      Value<String> commandId,
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> sessionId,
      Value<String> prompt,
      Value<bool> serverQueue,
      Value<bool> startNow,
      Value<String?> agent,
      Value<String?> model,
      Value<String?> reasoningEffort,
      Value<String> attachmentsJson,
      Value<double> createdAt,
      Value<int> rowid,
    });

class $$PendingFollowupCommandsTableFilterComposer
    extends Composer<_$AppDatabase, $PendingFollowupCommandsTable> {
  $$PendingFollowupCommandsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get commandId => $composableBuilder(
    column: $table.commandId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get prompt => $composableBuilder(
    column: $table.prompt,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get serverQueue => $composableBuilder(
    column: $table.serverQueue,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<bool> get startNow => $composableBuilder(
    column: $table.startNow,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get agent => $composableBuilder(
    column: $table.agent,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get reasoningEffort => $composableBuilder(
    column: $table.reasoningEffort,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get attachmentsJson => $composableBuilder(
    column: $table.attachmentsJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$PendingFollowupCommandsTableOrderingComposer
    extends Composer<_$AppDatabase, $PendingFollowupCommandsTable> {
  $$PendingFollowupCommandsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get commandId => $composableBuilder(
    column: $table.commandId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get prompt => $composableBuilder(
    column: $table.prompt,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get serverQueue => $composableBuilder(
    column: $table.serverQueue,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<bool> get startNow => $composableBuilder(
    column: $table.startNow,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get agent => $composableBuilder(
    column: $table.agent,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get model => $composableBuilder(
    column: $table.model,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get reasoningEffort => $composableBuilder(
    column: $table.reasoningEffort,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get attachmentsJson => $composableBuilder(
    column: $table.attachmentsJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get createdAt => $composableBuilder(
    column: $table.createdAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$PendingFollowupCommandsTableAnnotationComposer
    extends Composer<_$AppDatabase, $PendingFollowupCommandsTable> {
  $$PendingFollowupCommandsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get commandId =>
      $composableBuilder(column: $table.commandId, builder: (column) => column);

  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get prompt =>
      $composableBuilder(column: $table.prompt, builder: (column) => column);

  GeneratedColumn<bool> get serverQueue => $composableBuilder(
    column: $table.serverQueue,
    builder: (column) => column,
  );

  GeneratedColumn<bool> get startNow =>
      $composableBuilder(column: $table.startNow, builder: (column) => column);

  GeneratedColumn<String> get agent =>
      $composableBuilder(column: $table.agent, builder: (column) => column);

  GeneratedColumn<String> get model =>
      $composableBuilder(column: $table.model, builder: (column) => column);

  GeneratedColumn<String> get reasoningEffort => $composableBuilder(
    column: $table.reasoningEffort,
    builder: (column) => column,
  );

  GeneratedColumn<String> get attachmentsJson => $composableBuilder(
    column: $table.attachmentsJson,
    builder: (column) => column,
  );

  GeneratedColumn<double> get createdAt =>
      $composableBuilder(column: $table.createdAt, builder: (column) => column);
}

class $$PendingFollowupCommandsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $PendingFollowupCommandsTable,
          PendingFollowupCommand,
          $$PendingFollowupCommandsTableFilterComposer,
          $$PendingFollowupCommandsTableOrderingComposer,
          $$PendingFollowupCommandsTableAnnotationComposer,
          $$PendingFollowupCommandsTableCreateCompanionBuilder,
          $$PendingFollowupCommandsTableUpdateCompanionBuilder,
          (
            PendingFollowupCommand,
            BaseReferences<
              _$AppDatabase,
              $PendingFollowupCommandsTable,
              PendingFollowupCommand
            >,
          ),
          PendingFollowupCommand,
          PrefetchHooks Function()
        > {
  $$PendingFollowupCommandsTableTableManager(
    _$AppDatabase db,
    $PendingFollowupCommandsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$PendingFollowupCommandsTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$PendingFollowupCommandsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$PendingFollowupCommandsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> commandId = const Value.absent(),
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> prompt = const Value.absent(),
                Value<bool> serverQueue = const Value.absent(),
                Value<bool> startNow = const Value.absent(),
                Value<String?> agent = const Value.absent(),
                Value<String?> model = const Value.absent(),
                Value<String?> reasoningEffort = const Value.absent(),
                Value<String> attachmentsJson = const Value.absent(),
                Value<double> createdAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => PendingFollowupCommandsCompanion(
                commandId: commandId,
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                prompt: prompt,
                serverQueue: serverQueue,
                startNow: startNow,
                agent: agent,
                model: model,
                reasoningEffort: reasoningEffort,
                attachmentsJson: attachmentsJson,
                createdAt: createdAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String commandId,
                required String workspaceId,
                required String peonId,
                required String sessionId,
                required String prompt,
                required bool serverQueue,
                Value<bool> startNow = const Value.absent(),
                Value<String?> agent = const Value.absent(),
                Value<String?> model = const Value.absent(),
                Value<String?> reasoningEffort = const Value.absent(),
                Value<String> attachmentsJson = const Value.absent(),
                required double createdAt,
                Value<int> rowid = const Value.absent(),
              }) => PendingFollowupCommandsCompanion.insert(
                commandId: commandId,
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                prompt: prompt,
                serverQueue: serverQueue,
                startNow: startNow,
                agent: agent,
                model: model,
                reasoningEffort: reasoningEffort,
                attachmentsJson: attachmentsJson,
                createdAt: createdAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$PendingFollowupCommandsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $PendingFollowupCommandsTable,
      PendingFollowupCommand,
      $$PendingFollowupCommandsTableFilterComposer,
      $$PendingFollowupCommandsTableOrderingComposer,
      $$PendingFollowupCommandsTableAnnotationComposer,
      $$PendingFollowupCommandsTableCreateCompanionBuilder,
      $$PendingFollowupCommandsTableUpdateCompanionBuilder,
      (
        PendingFollowupCommand,
        BaseReferences<
          _$AppDatabase,
          $PendingFollowupCommandsTable,
          PendingFollowupCommand
        >,
      ),
      PendingFollowupCommand,
      PrefetchHooks Function()
    >;
typedef $$CachedQueuedFollowupsTableCreateCompanionBuilder =
    CachedQueuedFollowupsCompanion Function({
      required String workspaceId,
      required String peonId,
      required String sessionId,
      required String itemId,
      required String payloadJson,
      required int orderKey,
      required double syncedAt,
      Value<int> rowid,
    });
typedef $$CachedQueuedFollowupsTableUpdateCompanionBuilder =
    CachedQueuedFollowupsCompanion Function({
      Value<String> workspaceId,
      Value<String> peonId,
      Value<String> sessionId,
      Value<String> itemId,
      Value<String> payloadJson,
      Value<int> orderKey,
      Value<double> syncedAt,
      Value<int> rowid,
    });

class $$CachedQueuedFollowupsTableFilterComposer
    extends Composer<_$AppDatabase, $CachedQueuedFollowupsTable> {
  $$CachedQueuedFollowupsTableFilterComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnFilters<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get itemId => $composableBuilder(
    column: $table.itemId,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<int> get orderKey => $composableBuilder(
    column: $table.orderKey,
    builder: (column) => ColumnFilters(column),
  );

  ColumnFilters<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnFilters(column),
  );
}

class $$CachedQueuedFollowupsTableOrderingComposer
    extends Composer<_$AppDatabase, $CachedQueuedFollowupsTable> {
  $$CachedQueuedFollowupsTableOrderingComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  ColumnOrderings<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get peonId => $composableBuilder(
    column: $table.peonId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get sessionId => $composableBuilder(
    column: $table.sessionId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get itemId => $composableBuilder(
    column: $table.itemId,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<int> get orderKey => $composableBuilder(
    column: $table.orderKey,
    builder: (column) => ColumnOrderings(column),
  );

  ColumnOrderings<double> get syncedAt => $composableBuilder(
    column: $table.syncedAt,
    builder: (column) => ColumnOrderings(column),
  );
}

class $$CachedQueuedFollowupsTableAnnotationComposer
    extends Composer<_$AppDatabase, $CachedQueuedFollowupsTable> {
  $$CachedQueuedFollowupsTableAnnotationComposer({
    required super.$db,
    required super.$table,
    super.joinBuilder,
    super.$addJoinBuilderToRootComposer,
    super.$removeJoinBuilderFromRootComposer,
  });
  GeneratedColumn<String> get workspaceId => $composableBuilder(
    column: $table.workspaceId,
    builder: (column) => column,
  );

  GeneratedColumn<String> get peonId =>
      $composableBuilder(column: $table.peonId, builder: (column) => column);

  GeneratedColumn<String> get sessionId =>
      $composableBuilder(column: $table.sessionId, builder: (column) => column);

  GeneratedColumn<String> get itemId =>
      $composableBuilder(column: $table.itemId, builder: (column) => column);

  GeneratedColumn<String> get payloadJson => $composableBuilder(
    column: $table.payloadJson,
    builder: (column) => column,
  );

  GeneratedColumn<int> get orderKey =>
      $composableBuilder(column: $table.orderKey, builder: (column) => column);

  GeneratedColumn<double> get syncedAt =>
      $composableBuilder(column: $table.syncedAt, builder: (column) => column);
}

class $$CachedQueuedFollowupsTableTableManager
    extends
        RootTableManager<
          _$AppDatabase,
          $CachedQueuedFollowupsTable,
          CachedQueuedFollowup,
          $$CachedQueuedFollowupsTableFilterComposer,
          $$CachedQueuedFollowupsTableOrderingComposer,
          $$CachedQueuedFollowupsTableAnnotationComposer,
          $$CachedQueuedFollowupsTableCreateCompanionBuilder,
          $$CachedQueuedFollowupsTableUpdateCompanionBuilder,
          (
            CachedQueuedFollowup,
            BaseReferences<
              _$AppDatabase,
              $CachedQueuedFollowupsTable,
              CachedQueuedFollowup
            >,
          ),
          CachedQueuedFollowup,
          PrefetchHooks Function()
        > {
  $$CachedQueuedFollowupsTableTableManager(
    _$AppDatabase db,
    $CachedQueuedFollowupsTable table,
  ) : super(
        TableManagerState(
          db: db,
          table: table,
          createFilteringComposer: () =>
              $$CachedQueuedFollowupsTableFilterComposer(
                $db: db,
                $table: table,
              ),
          createOrderingComposer: () =>
              $$CachedQueuedFollowupsTableOrderingComposer(
                $db: db,
                $table: table,
              ),
          createComputedFieldComposer: () =>
              $$CachedQueuedFollowupsTableAnnotationComposer(
                $db: db,
                $table: table,
              ),
          updateCompanionCallback:
              ({
                Value<String> workspaceId = const Value.absent(),
                Value<String> peonId = const Value.absent(),
                Value<String> sessionId = const Value.absent(),
                Value<String> itemId = const Value.absent(),
                Value<String> payloadJson = const Value.absent(),
                Value<int> orderKey = const Value.absent(),
                Value<double> syncedAt = const Value.absent(),
                Value<int> rowid = const Value.absent(),
              }) => CachedQueuedFollowupsCompanion(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                itemId: itemId,
                payloadJson: payloadJson,
                orderKey: orderKey,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          createCompanionCallback:
              ({
                required String workspaceId,
                required String peonId,
                required String sessionId,
                required String itemId,
                required String payloadJson,
                required int orderKey,
                required double syncedAt,
                Value<int> rowid = const Value.absent(),
              }) => CachedQueuedFollowupsCompanion.insert(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: sessionId,
                itemId: itemId,
                payloadJson: payloadJson,
                orderKey: orderKey,
                syncedAt: syncedAt,
                rowid: rowid,
              ),
          withReferenceMapper: (p0) => p0
              .map((e) => (e.readTable(table), BaseReferences(db, table, e)))
              .toList(),
          prefetchHooksCallback: null,
        ),
      );
}

typedef $$CachedQueuedFollowupsTableProcessedTableManager =
    ProcessedTableManager<
      _$AppDatabase,
      $CachedQueuedFollowupsTable,
      CachedQueuedFollowup,
      $$CachedQueuedFollowupsTableFilterComposer,
      $$CachedQueuedFollowupsTableOrderingComposer,
      $$CachedQueuedFollowupsTableAnnotationComposer,
      $$CachedQueuedFollowupsTableCreateCompanionBuilder,
      $$CachedQueuedFollowupsTableUpdateCompanionBuilder,
      (
        CachedQueuedFollowup,
        BaseReferences<
          _$AppDatabase,
          $CachedQueuedFollowupsTable,
          CachedQueuedFollowup
        >,
      ),
      CachedQueuedFollowup,
      PrefetchHooks Function()
    >;

class $AppDatabaseManager {
  final _$AppDatabase _db;
  $AppDatabaseManager(this._db);
  $$CachedSessionsTableTableManager get cachedSessions =>
      $$CachedSessionsTableTableManager(_db, _db.cachedSessions);
  $$CachedWorkspacesTableTableManager get cachedWorkspaces =>
      $$CachedWorkspacesTableTableManager(_db, _db.cachedWorkspaces);
  $$CachedFleetPeonsTableTableManager get cachedFleetPeons =>
      $$CachedFleetPeonsTableTableManager(_db, _db.cachedFleetPeons);
  $$CachedProjectsTableTableManager get cachedProjects =>
      $$CachedProjectsTableTableManager(_db, _db.cachedProjects);
  $$CachedAiStatsTableTableManager get cachedAiStats =>
      $$CachedAiStatsTableTableManager(_db, _db.cachedAiStats);
  $$CachedPeonManagementTableTableManager get cachedPeonManagement =>
      $$CachedPeonManagementTableTableManager(_db, _db.cachedPeonManagement);
  $$LiveCursorsTableTableManager get liveCursors =>
      $$LiveCursorsTableTableManager(_db, _db.liveCursors);
  $$CachedTranscriptEventsTableTableManager get cachedTranscriptEvents =>
      $$CachedTranscriptEventsTableTableManager(
        _db,
        _db.cachedTranscriptEvents,
      );
  $$CachedTranscriptsTableTableManager get cachedTranscripts =>
      $$CachedTranscriptsTableTableManager(_db, _db.cachedTranscripts);
  $$ComposerDraftsTableTableManager get composerDrafts =>
      $$ComposerDraftsTableTableManager(_db, _db.composerDrafts);
  $$PendingFollowupCommandsTableTableManager get pendingFollowupCommands =>
      $$PendingFollowupCommandsTableTableManager(
        _db,
        _db.pendingFollowupCommands,
      );
  $$CachedQueuedFollowupsTableTableManager get cachedQueuedFollowups =>
      $$CachedQueuedFollowupsTableTableManager(_db, _db.cachedQueuedFollowups);
}
