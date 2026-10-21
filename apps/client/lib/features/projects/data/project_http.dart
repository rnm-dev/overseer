import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../../core/network/server_error_message.dart';
import '../domain/project_detail_models.dart';
import '../domain/project_models.dart';

/// Maps an Overseer error body (`{error, code}`) onto a [ProjectsException].
ProjectsException projectsExceptionFrom(DioException error, String fallback) {
  final data = error.response?.data;
  final code = data is Map && data['code'] is String
      ? data['code'] as String
      : null;
  return ProjectsException(error.serverMessage ?? fallback, code: code);
}

/// URL-encodes each segment of a project-relative path.
String encodeProjectPath(String path) => path
    .split('/')
    .where((segment) => segment.isNotEmpty)
    .map(Uri.encodeComponent)
    .join('/');

/// Downloads the raw bytes of a project file at [url].
Future<ProjectFilePreview> fetchProjectFile(
  Dio dio, {
  required String url,
  required String path,
  required String fallbackMessage,
}) async {
  try {
    final response = await dio.get<List<int>>(
      url,
      options: Options(responseType: ResponseType.bytes),
    );
    return ProjectFilePreview(
      path: path,
      bytes: Uint8List.fromList(response.data ?? const []),
      contentType: response.headers.value(Headers.contentTypeHeader),
    );
  } on DioException catch (error) {
    throw projectsExceptionFrom(error, fallbackMessage);
  }
}
