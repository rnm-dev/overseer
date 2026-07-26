import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/data/dio_voice_input_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';

void main() {
  test('caches capabilities for the connection', () async {
    final adapter = _VoiceAdapter();
    final repository = DioVoiceInputRepository(
      Dio(BaseOptions(baseUrl: 'https://overseer.example/api/v1/'))
        ..httpClientAdapter = adapter,
    );

    final first = await repository.capabilities();
    final second = await repository.capabilities();

    expect(first.enabled, isTrue);
    expect(second.maxDuration, const Duration(seconds: 120));
    expect(adapter.capabilityCalls, 1);
  });

  test('uploads raw m4a once more after a network failure', () async {
    final adapter = _VoiceAdapter(failFirstTranscription: true);
    final repository = DioVoiceInputRepository(
      Dio(BaseOptions(baseUrl: 'https://overseer.example/api/v1/'))
        ..httpClientAdapter = adapter,
    );

    final result = await repository.transcribe(
      scope: const FollowupScope(
        workspaceId: 'workspace',
        peonId: 'peon',
        sessionId: 'session',
      ),
      audio: Uint8List.fromList([1, 2, 3]),
    );

    expect(result.text, 'hello');
    expect(adapter.transcriptionCalls, 2);
    expect(adapter.lastRequest?.contentType, 'audio/mp4');
    expect(adapter.lastRequest?.queryParameters, {
      'workspaceId': 'workspace',
      'peonId': 'peon',
      'sessionId': 'session',
    });
    expect(adapter.lastBody, [1, 2, 3]);
  });
}

class _VoiceAdapter implements HttpClientAdapter {
  _VoiceAdapter({this.failFirstTranscription = false});

  final bool failFirstTranscription;
  int capabilityCalls = 0;
  int transcriptionCalls = 0;
  RequestOptions? lastRequest;
  List<int>? lastBody;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.path.endsWith('voice/capabilities')) {
      capabilityCalls++;
      return _json({
        'enabled': true,
        'maxDurationMs': 120000,
        'maxBytes': 4194304,
        'mediaTypes': ['audio/mp4'],
        'polish': true,
      });
    }
    if (options.path.endsWith('voice/transcriptions')) {
      transcriptionCalls++;
      lastRequest = options;
      lastBody = await requestStream?.expand((chunk) => chunk).toList();
      if (failFirstTranscription && transcriptionCalls == 1) {
        throw DioException(
          requestOptions: options,
          type: DioExceptionType.connectionError,
          message: 'offline',
        );
      }
      return _json({'text': 'hello', 'language': 'en', 'latencyMs': 240});
    }
    throw StateError('Unexpected request: ${options.method} ${options.path}');
  }

  ResponseBody _json(Map<String, dynamic> body) => ResponseBody.fromString(
    jsonEncode(body),
    200,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
    },
  );

  @override
  void close({bool force = false}) {}
}
