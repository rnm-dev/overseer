import 'dart:typed_data';

import 'followup_repository.dart';

class VoiceCapabilities {
  const VoiceCapabilities({
    required this.enabled,
    required this.maxDuration,
    required this.maxBytes,
  });

  final bool enabled;
  final Duration maxDuration;
  final int maxBytes;
}

class VoiceTranscription {
  const VoiceTranscription({required this.text});

  final String text;
}

enum VoiceInputErrorKind {
  disabled,
  rateLimited,
  provider,
  network,
  tooLarge,
  unsupported,
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
    Future<void>? cancelFuture,
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

  /// A platform-calibrated silence threshold, or `null` when recorder
  /// metering is not reliable enough to reject a non-empty take locally.
  double? get silenceThresholdRms;

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
