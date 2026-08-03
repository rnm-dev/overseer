import 'package:dio/dio.dart';

import '../domain/plugin_inquiry.dart';
import '../domain/plugin_inquiry_repository.dart';

class DioPluginInquiryRepository implements PluginInquiryRepository {
  const DioPluginInquiryRepository(this._dio);

  final Dio _dio;

  String _base(PluginInquiryScope scope) =>
      'workspaces/${Uri.encodeComponent(scope.workspaceId)}/peons/'
      '${Uri.encodeComponent(scope.peonId)}/sessions/'
      '${Uri.encodeComponent(scope.sessionId)}/inquiries';

  @override
  Future<List<PluginInstallInquiry>> list(PluginInquiryScope scope) async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        _base(scope),
        options: Options(headers: const {'Cache-Control': 'no-store'}),
      );
      final rows = response.data?['inquiries'];
      if (response.data?['version'] != 'inquiry-v1' || rows is! List) {
        throw const FormatException('Missing inquiries');
      }
      return rows
          .map(
            (row) => PluginInstallInquiry.fromJson(
              Map<String, dynamic>.from(row as Map),
            ),
          )
          .toList(growable: false);
    } on DioException catch (error) {
      throw _exception(error, 'Could not refresh plugin requests.');
    } on Object catch (error) {
      if (error is PluginInquiryException) rethrow;
      throw const PluginInquiryException(
        'Overseer returned an invalid plugin request.',
      );
    }
  }

  @override
  Future<PluginInstallInquiry> respond(
    PluginInquiryScope scope, {
    required String inquiryId,
    required PluginInquiryDecision decision,
    required String requestId,
  }) async {
    try {
      final response = await _dio.post<Map<String, dynamic>>(
        '${_base(scope)}/${Uri.encodeComponent(inquiryId)}/response',
        data: {'action': decision.name},
        options: Options(headers: {'Peon-Request-Id': requestId}),
      );
      final body = response.data;
      if (body == null) throw const FormatException('Empty inquiry response');
      return PluginInstallInquiry.fromJson(body);
    } on DioException catch (error) {
      throw _exception(error, 'Could not update the plugin request.');
    } on Object catch (error) {
      if (error is PluginInquiryException) rethrow;
      throw const PluginInquiryException(
        'Overseer returned an invalid plugin request.',
      );
    }
  }

  PluginInquiryException _exception(DioException error, String fallback) {
    final body = error.response?.data;
    final code = body is Map ? body['code']?.toString() : null;
    final status = error.response?.statusCode;
    return PluginInquiryException(
      fallback,
      code: code,
      transient:
          status == null ||
          status == 408 ||
          status == 425 ||
          status == 429 ||
          status >= 500,
    );
  }
}
