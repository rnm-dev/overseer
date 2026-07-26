import 'dart:typed_data';

import 'followup_repository.dart';

class VoiceCapabilities {
  const VoiceCapabilities({
    required this.enabled,
    required this.maxDuration,
    required this.maxBytes,
    required this.mediaTypes,
    required this.polish,
  });

  final bool enabled;
  final Duration maxDuration;
  final int maxBytes;
  final List<String> mediaTypes;
  final bool polish;
}

class VoiceTranscription {
  const VoiceTranscription({required this.text, this.language, this.latency});

  final String text;
  final String? language;
  final Duration? latency;
}

enum VoiceInputErrorKind {
  permissionDenied,
  permissionPermanentlyDenied,
  disabled,
  rateLimited,
  provider,
  network,
  tooLarge,
  unsupported,
  nothingSaid,
  unavailable,
}

class VoiceInputException implements Exception {
  const VoiceInputException(this.kind, this.message);

  final VoiceInputErrorKind kind;
  final String message;

  @override
  String toString() => message;
}

abstract interface class VoiceInputRepository {
  Future<VoiceCapabilities> capabilities();

  Future<VoiceTranscription> transcribe({
    required FollowupScope scope,
    required Uint8List audio,
  });
}

enum MicrophonePermission { granted, denied, permanentlyDenied, restricted }

abstract interface class MicrophonePermissionGateway {
  Future<MicrophonePermission> request();

  Future<bool> openSettings();
}

class VoiceTake {
  const VoiceTake({
    required this.bytes,
    required this.duration,
    required this.rms,
  });

  final Uint8List bytes;
  final Duration duration;
  final double rms;
}

abstract interface class VoiceRecorder {
  bool get supported;

  Stream<double> get amplitude;

  Stream<void> get interruptions;

  Future<void> start();

  Future<VoiceTake> stop();

  Future<void> cancel();

  Future<void> dispose();
}

abstract interface class VoiceRecorderFactory {
  VoiceRecorder create();
}
