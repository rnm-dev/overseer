import 'dart:async';
import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../domain/followup_repository.dart';
import '../domain/voice_input.dart';

class DioVoiceInputRepository implements VoiceInputRepository {
  DioVoiceInputRepository(this._dio, {required Uri apiUrl})
    : _apiUrl = apiUrl.resolve('./');

  final Dio _dio;
  final Uri _apiUrl;
  Future<VoiceCapabilities>? _cachedCapabilities;

  static const _requestTimeout = Duration(seconds: 20);

  @override
  Future<VoiceCapabilities> capabilities() {
    return _cachedCapabilities ??= _fetchCapabilities().catchError((error) {
      _cachedCapabilities = null;
      throw error;
    });
  }

  Future<VoiceCapabilities> _fetchCapabilities() async {
    try {
      final response = await _dio.get<Map<String, dynamic>>(
        _apiUrl.resolve('voice/capabilities').toString(),
      );
      final data = response.data ?? const <String, dynamic>{};
      return VoiceCapabilities(
        enabled: data['enabled'] == true,
        maxDuration: Duration(
          milliseconds: (data['maxDurationMs'] as num?)?.toInt() ?? 120000,
        ),
        maxBytes: (data['maxBytes'] as num?)?.toInt() ?? 4 * 1024 * 1024,
        mediaTypes:
            (data['mediaTypes'] as List<dynamic>?)?.whereType<String>().toList(
              growable: false,
            ) ??
            const ['audio/mp4'],
        polish: data['polish'] == true,
      );
    } on DioException catch (error) {
      throw _mapError(error);
    }
  }

  @override
  Future<VoiceTranscription> transcribe({
    required FollowupScope scope,
    required Uint8List audio,
    Future<void>? cancelFuture,
  }) async {
    final cancelToken = CancelToken();
    cancelFuture?.then((_) {
      if (!cancelToken.isCancelled) {
        cancelToken.cancel('Voice transcription canceled.');
      }
    });
    for (var attempt = 0; ; attempt++) {
      try {
        final response = await _dio.post<Map<String, dynamic>>(
          _apiUrl.resolve('voice/transcriptions').toString(),
          queryParameters: {
            'workspaceId': scope.workspaceId,
            'peonId': scope.peonId,
            'sessionId': scope.sessionId,
          },
          data: Stream<List<int>>.value(audio),
          options: Options(
            contentType: 'audio/mp4',
            headers: {Headers.contentLengthHeader: audio.length},
            sendTimeout: _requestTimeout,
            receiveTimeout: _requestTimeout,
          ),
          cancelToken: cancelToken,
        );
        final data = response.data ?? const <String, dynamic>{};
        final latencyMs = (data['latencyMs'] as num?)?.toInt();
        return VoiceTranscription(
          text: data['text'] as String? ?? '',
          language: data['language'] as String?,
          latency: latencyMs == null ? null : Duration(milliseconds: latencyMs),
        );
      } on DioException catch (error) {
        if (attempt == 0 && _isRetryableNetworkError(error)) continue;
        throw _mapError(error);
      }
    }
  }

  bool _isRetryableNetworkError(DioException error) {
    return switch (error.type) {
      DioExceptionType.connectionError ||
      DioExceptionType.connectionTimeout ||
      DioExceptionType.sendTimeout ||
      DioExceptionType.receiveTimeout => true,
      _ => false,
    };
  }

  VoiceInputException _mapError(DioException error) {
    final data = error.response?.data;
    final code = data is Map ? data['code'] as String? : null;
    return switch (code) {
      'VOICE_DISABLED' => const VoiceInputException(
        VoiceInputErrorKind.disabled,
        'Voice input is disabled on this Overseer.',
      ),
      'AUDIO_TOO_LARGE' => const VoiceInputException(
        VoiceInputErrorKind.tooLarge,
        'That recording is too large. Try a shorter take.',
      ),
      'UNSUPPORTED_MEDIA_TYPE' => const VoiceInputException(
        VoiceInputErrorKind.unsupported,
        'This Overseer does not accept the recorded audio format.',
      ),
      'VOICE_RATE_LIMITED' => const VoiceInputException(
        VoiceInputErrorKind.rateLimited,
        'Voice input is busy. Wait a moment and try again.',
      ),
      'VOICE_PROVIDER_ERROR' => const VoiceInputException(
        VoiceInputErrorKind.provider,
        'The speech provider could not transcribe this take.',
      ),
      _ when _isRetryableNetworkError(error) => const VoiceInputException(
        VoiceInputErrorKind.network,
        'Could not transcribe over this connection. Please try again.',
      ),
      _ => const VoiceInputException(
        VoiceInputErrorKind.provider,
        'Voice transcription failed. Please try again.',
      ),
    };
  }
}
