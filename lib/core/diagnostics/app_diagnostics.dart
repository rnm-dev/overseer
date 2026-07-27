import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final appDiagnosticsProvider = Provider<AppDiagnostics>(
  (ref) => const NoopAppDiagnostics(),
);

enum AppDiagnosticLevel { debug, info, warning, error }

class AppDiagnosticEvent {
  const AppDiagnosticEvent({
    required this.name,
    this.level = AppDiagnosticLevel.info,
    this.connectionId,
    this.workspaceId,
    this.sessionId,
    this.state,
    this.outcome,
    this.cursor,
    this.attempt,
    this.errorType,
  });

  final String name;
  final AppDiagnosticLevel level;
  final String? connectionId;
  final String? workspaceId;
  final String? sessionId;
  final String? state;
  final String? outcome;
  final int? cursor;
  final int? attempt;
  final String? errorType;

  Map<String, Object?> toJson() => {
    'event': name,
    'level': level.name,
    if (connectionId != null) 'connectionId': connectionId,
    if (workspaceId != null) 'workspaceId': workspaceId,
    if (sessionId != null) 'sessionId': sessionId,
    if (state != null) 'state': state,
    if (outcome != null) 'outcome': outcome,
    if (cursor != null) 'cursor': cursor,
    if (attempt != null) 'attempt': attempt,
    if (errorType != null) 'errorType': errorType,
  };
}

abstract interface class AppDiagnostics {
  void record(AppDiagnosticEvent event);
}

class NoopAppDiagnostics implements AppDiagnostics {
  const NoopAppDiagnostics();

  @override
  void record(AppDiagnosticEvent event) {}
}

class DebugPrintAppDiagnostics implements AppDiagnostics {
  const DebugPrintAppDiagnostics();

  @override
  void record(AppDiagnosticEvent event) {
    debugPrint('[Overseer] ${jsonEncode(event.toJson())}');
  }
}
