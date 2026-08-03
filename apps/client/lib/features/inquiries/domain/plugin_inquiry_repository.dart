import 'plugin_inquiry.dart';

enum PluginInquiryDecision { install, cancel }

class PluginInquiryScope {
  const PluginInquiryScope({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
    this.supported = true,
    this.online = true,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;
  final bool supported;
  final bool online;

  @override
  bool operator ==(Object other) =>
      other is PluginInquiryScope &&
      other.workspaceId == workspaceId &&
      other.peonId == peonId &&
      other.sessionId == sessionId &&
      other.supported == supported &&
      other.online == online;

  @override
  int get hashCode =>
      Object.hash(workspaceId, peonId, sessionId, supported, online);
}

abstract interface class PluginInquiryRepository {
  Future<List<PluginInstallInquiry>> list(PluginInquiryScope scope);

  Future<PluginInstallInquiry> respond(
    PluginInquiryScope scope, {
    required String inquiryId,
    required PluginInquiryDecision decision,
    required String requestId,
  });
}

class PluginInquiryException implements Exception {
  const PluginInquiryException(
    this.message, {
    this.code,
    this.transient = false,
  });

  final String message;
  final String? code;
  final bool transient;

  @override
  String toString() => message;
}
