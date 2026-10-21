import 'package:dio/dio.dart';

import '../domain/project_file_transfer_repository.dart';
import 'project_http.dart';

/// Uploads are a streamed `PUT` of one file; a move is a `PATCH` carrying the
/// destination path. Both are relative to the project root and land on the
/// same Peon file routes the web file tree uses, so refusals (an existing
/// destination, a path escape, the size limit) read identically everywhere.
class DioProjectFileTransfers implements ProjectFileTransferRepository {
  DioProjectFileTransfers(this._dio);

  final Dio _dio;

  @override
  Future<void> upload({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String path,
    required Stream<List<int>> bytes,
    required int length,
    void Function(int sent, int total)? onProgress,
  }) async {
    try {
      await _dio.put<Object?>(
        _filesUrl(workspaceId, peonId, projectKey, path),
        data: bytes,
        onSendProgress: onProgress,
        options: Options(
          contentType: 'application/octet-stream',
          headers: {Headers.contentLengthHeader: length},
          // Large files over a mobile link outlive the default timeouts.
          sendTimeout: const Duration(minutes: 30),
        ),
      );
    } on DioException catch (error) {
      throw projectsExceptionFrom(error, 'Could not upload this file.');
    }
  }

  @override
  Future<void> move({
    required String workspaceId,
    required String peonId,
    required String projectKey,
    required String source,
    required String destination,
  }) async {
    try {
      await _dio.patch<Object?>(
        _filesUrl(workspaceId, peonId, projectKey, source),
        data: {'destination': destination},
      );
    } on DioException catch (error) {
      throw projectsExceptionFrom(error, 'Could not move this item.');
    }
  }

  String _filesUrl(
    String workspaceId,
    String peonId,
    String projectKey,
    String path,
  ) {
    return 'workspaces/${Uri.encodeComponent(workspaceId)}/peons/'
        '${Uri.encodeComponent(peonId)}/projects/'
        '${Uri.encodeComponent(projectKey)}/files/${encodeProjectPath(path)}';
  }
}
