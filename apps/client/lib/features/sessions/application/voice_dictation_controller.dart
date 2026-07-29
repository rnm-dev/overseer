import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../core/diagnostics/app_diagnostics.dart';
import '../../../core/time/app_time.dart';
import '../domain/followup_repository.dart';
import '../domain/voice_input.dart';

final voiceInputRepositoryProvider = Provider<VoiceInputRepository>(
  (ref) => const _UnavailableVoiceInputRepository(),
);

final microphonePermissionGatewayProvider =
    Provider<MicrophonePermissionGateway>(
      (ref) => const _UnavailableMicrophonePermissionGateway(),
    );

final voiceRecorderFactoryProvider = Provider<VoiceRecorderFactory>(
  (ref) => const _UnavailableVoiceRecorderFactory(),
);

final voiceDictationControllerProvider = NotifierProvider.autoDispose
    .family<VoiceDictationController, VoiceDictationState, FollowupScope>(
      VoiceDictationController.new,
    );

enum VoiceDictationPhase { loading, idle, recording, transcribing, unavailable }

class VoiceDictationState {
  const VoiceDictationState({
    required this.phase,
    this.enabled = false,
    this.duration = Duration.zero,
    this.maxDuration = const Duration(seconds: 120),
    this.amplitude = 0,
    this.error,
    this.canOpenSettings = false,
    this.completedText,
    this.completionId = 0,
  });

  final VoiceDictationPhase phase;
  final bool enabled;
  final Duration duration;
  final Duration maxDuration;
  final double amplitude;
  final String? error;
  final bool canOpenSettings;
  final String? completedText;
  final int completionId;

  bool get showMicrophone => enabled && phase != VoiceDictationPhase.loading;

  VoiceDictationState copyWith({
    VoiceDictationPhase? phase,
    bool? enabled,
    Duration? duration,
    Duration? maxDuration,
    double? amplitude,
    String? error,
    bool clearError = false,
    bool? canOpenSettings,
    String? completedText,
    bool clearCompletedText = false,
    int? completionId,
  }) {
    return VoiceDictationState(
      phase: phase ?? this.phase,
      enabled: enabled ?? this.enabled,
      duration: duration ?? this.duration,
      maxDuration: maxDuration ?? this.maxDuration,
      amplitude: amplitude ?? this.amplitude,
      error: clearError ? null : error ?? this.error,
      canOpenSettings: canOpenSettings ?? this.canOpenSettings,
      completedText: clearCompletedText
          ? null
          : completedText ?? this.completedText,
      completionId: completionId ?? this.completionId,
    );
  }
}

class VoiceDictationController extends Notifier<VoiceDictationState> {
  VoiceDictationController(this.scope);

  final FollowupScope scope;
  VoiceRecorder? _recorder;
  VoiceCapabilities? _capabilities;
  StreamSubscription<double>? _amplitudeSubscription;
  StreamSubscription<void>? _interruptionSubscription;
  ScheduledTask? _durationTimer;
  DateTime? _startedAt;
  Completer<void>? _transcriptionCancellation;
  bool _stopping = false;
  int _operationId = 0;
  late AppClock _clock;
  late AppScheduler _scheduler;
  late AppDiagnostics _diagnostics;

  static const _clientMaxDuration = Duration(seconds: 120);
  static const _minimumDuration = Duration(milliseconds: 300);
  @override
  VoiceDictationState build() {
    _clock = ref.read(appClockProvider);
    _scheduler = ref.read(appSchedulerProvider);
    _diagnostics = ref.read(appDiagnosticsProvider);
    final recorder = ref.read(voiceRecorderFactoryProvider).create();
    _recorder = recorder;
    ref.onDispose(() {
      _durationTimer?.cancel();
      unawaited(_amplitudeSubscription?.cancel());
      unawaited(_interruptionSubscription?.cancel());
      _transcriptionCancellation?.complete();
      unawaited(recorder.dispose());
    });
    if (!recorder.supported) {
      return const VoiceDictationState(phase: VoiceDictationPhase.unavailable);
    }
    Future<void>.microtask(_loadCapabilities);
    return const VoiceDictationState(phase: VoiceDictationPhase.loading);
  }

  Future<void> _loadCapabilities() async {
    try {
      final repository = ref.read(voiceInputRepositoryProvider);
      final capabilities = await repository.capabilities();
      if (!ref.mounted) return;
      _capabilities = capabilities;
      final maxDuration = capabilities.maxDuration < _clientMaxDuration
          ? capabilities.maxDuration
          : _clientMaxDuration;
      state = VoiceDictationState(
        phase: capabilities.enabled
            ? VoiceDictationPhase.idle
            : VoiceDictationPhase.unavailable,
        enabled: capabilities.enabled,
        maxDuration: maxDuration,
      );
    } catch (error) {
      if (!ref.mounted) return;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'voice.capabilities',
          level: AppDiagnosticLevel.warning,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          state: 'unavailable',
          errorType: error.runtimeType.toString(),
        ),
      );
      // Older or currently unreachable instances do not expose a broken mic.
      state = const VoiceDictationState(phase: VoiceDictationPhase.unavailable);
    }
  }

  Future<bool> start() async {
    if (state.phase != VoiceDictationPhase.idle || !state.enabled) return false;
    final permissionGateway = ref.read(microphonePermissionGatewayProvider);
    final permission = await permissionGateway.request();
    if (!ref.mounted) return false;
    if (permission != MicrophonePermission.granted) {
      final permanent =
          permission == MicrophonePermission.permanentlyDenied ||
          permission == MicrophonePermission.restricted;
      state = state.copyWith(
        phase: VoiceDictationPhase.idle,
        error: permanent
            ? 'Microphone access is blocked. Enable it in system settings.'
            : 'Microphone permission is required for dictation.',
        canOpenSettings: permanent,
      );
      return false;
    }

    try {
      await _recorder!.start();
      if (!ref.mounted) {
        await _recorder!.cancel();
        return false;
      }
      _startedAt = _clock.now();
      _amplitudeSubscription = _recorder!.amplitude.listen((amplitude) {
        if (state.phase != VoiceDictationPhase.recording) return;
        state = state.copyWith(amplitude: amplitude);
      });
      _interruptionSubscription = _recorder!.interruptions.listen((_) {
        unawaited(
          cancel(message: 'Recording was discarded after an interruption.'),
        );
      });
      _durationTimer = _scheduler.periodic(
        const Duration(milliseconds: 250),
        () {
          if (state.phase != VoiceDictationPhase.recording) return;
          final duration = _clock.now().difference(_startedAt!);
          state = state.copyWith(duration: duration);
          if (duration >= state.maxDuration) unawaited(stop());
        },
      );
      state = state.copyWith(
        phase: VoiceDictationPhase.recording,
        duration: Duration.zero,
        amplitude: 0,
        clearError: true,
        canOpenSettings: false,
        clearCompletedText: true,
      );
      return true;
    } on VoiceInputException catch (error) {
      if (!ref.mounted) return false;
      state = state.copyWith(
        phase: VoiceDictationPhase.idle,
        error: error.message,
        canOpenSettings: false,
      );
      return false;
    } catch (error) {
      if (!ref.mounted) return false;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'voice.recording',
          level: AppDiagnosticLevel.error,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          state: 'start_failed',
          errorType: error.runtimeType.toString(),
        ),
      );
      state = state.copyWith(
        phase: VoiceDictationPhase.idle,
        error: 'Could not start the microphone. Please try again.',
        canOpenSettings: false,
      );
      return false;
    }
  }

  Future<void> stop() async {
    if (state.phase != VoiceDictationPhase.recording || _stopping) return;
    final operationId = ++_operationId;
    _stopping = true;
    _stopClockAndStreams();
    try {
      final take = await _recorder!.stop();
      if (!ref.mounted) return;
      if (take.duration < _minimumDuration) {
        state = state.copyWith(
          phase: VoiceDictationPhase.idle,
          duration: Duration.zero,
          amplitude: 0,
          error: 'Tap was too short to record speech.',
        );
        return;
      }
      final silenceThreshold = _recorder!.silenceThresholdRms;
      if (take.bytes.isEmpty ||
          (silenceThreshold != null && take.rms < silenceThreshold)) {
        state = state.copyWith(
          phase: VoiceDictationPhase.idle,
          duration: Duration.zero,
          amplitude: 0,
          error: 'No speech was detected.',
        );
        return;
      }
      final capabilities = _capabilities;
      if (capabilities != null && take.bytes.length > capabilities.maxBytes) {
        state = state.copyWith(
          phase: VoiceDictationPhase.idle,
          duration: Duration.zero,
          amplitude: 0,
          error: 'That recording is too large. Try a shorter take.',
        );
        return;
      }

      state = state.copyWith(
        phase: VoiceDictationPhase.transcribing,
        duration: Duration.zero,
        amplitude: 0,
        clearError: true,
      );
      final repository = ref.read(voiceInputRepositoryProvider);
      final cancellation = Completer<void>();
      _transcriptionCancellation = cancellation;
      final result = await repository.transcribe(
        scope: scope,
        audio: take.bytes,
        cancelFuture: cancellation.future,
      );
      if (!ref.mounted || operationId != _operationId) return;
      final text = result.text.trim();
      state = state.copyWith(
        phase: VoiceDictationPhase.idle,
        error: text.isEmpty ? 'Nothing was said.' : null,
        clearError: text.isNotEmpty,
        completedText: text.isEmpty ? null : text,
        completionId: text.isEmpty
            ? state.completionId
            : state.completionId + 1,
      );
    } on VoiceInputException catch (error) {
      if (!ref.mounted || operationId != _operationId) return;
      state = state.copyWith(
        phase: error.kind == VoiceInputErrorKind.disabled
            ? VoiceDictationPhase.unavailable
            : VoiceDictationPhase.idle,
        enabled: error.kind == VoiceInputErrorKind.disabled
            ? false
            : state.enabled,
        error: error.message,
      );
    } catch (error) {
      if (!ref.mounted || operationId != _operationId) return;
      _diagnostics.record(
        AppDiagnosticEvent(
          name: 'voice.transcription',
          level: AppDiagnosticLevel.error,
          workspaceId: scope.workspaceId,
          sessionId: scope.sessionId,
          state: 'failed',
          errorType: error.runtimeType.toString(),
        ),
      );
      state = state.copyWith(
        phase: VoiceDictationPhase.idle,
        error: 'Voice transcription failed. Please try again.',
      );
    } finally {
      if (operationId == _operationId) {
        _transcriptionCancellation = null;
        _stopping = false;
      }
    }
  }

  Future<void> cancel({String? message}) async {
    final phase = state.phase;
    if (phase != VoiceDictationPhase.recording &&
        phase != VoiceDictationPhase.transcribing) {
      return;
    }
    _operationId++;
    _stopping = false;
    _stopClockAndStreams();
    if (phase == VoiceDictationPhase.recording) {
      await _recorder!.cancel();
    } else {
      _transcriptionCancellation?.complete();
      _transcriptionCancellation = null;
    }
    if (!ref.mounted) return;
    state = state.copyWith(
      phase: VoiceDictationPhase.idle,
      duration: Duration.zero,
      amplitude: 0,
      error: message,
      clearError: message == null,
    );
  }

  Future<bool> openSettings() {
    final gateway = ref.read(microphonePermissionGatewayProvider);
    return gateway.openSettings();
  }

  void clearError() {
    if (state.error != null) {
      state = state.copyWith(clearError: true, canOpenSettings: false);
    }
  }

  void _stopClockAndStreams() {
    _durationTimer?.cancel();
    _durationTimer = null;
    unawaited(_amplitudeSubscription?.cancel());
    unawaited(_interruptionSubscription?.cancel());
    _amplitudeSubscription = null;
    _interruptionSubscription = null;
  }
}

class _UnavailableVoiceInputRepository implements VoiceInputRepository {
  const _UnavailableVoiceInputRepository();

  @override
  Future<VoiceCapabilities> capabilities() {
    throw const VoiceInputException(
      VoiceInputErrorKind.unavailable,
      'Voice input is unavailable.',
    );
  }

  @override
  Future<VoiceTranscription> transcribe({
    required FollowupScope scope,
    required Uint8List audio,
    Future<void>? cancelFuture,
  }) {
    throw const VoiceInputException(
      VoiceInputErrorKind.unavailable,
      'Voice input is unavailable.',
    );
  }
}

class _UnavailableMicrophonePermissionGateway
    implements MicrophonePermissionGateway {
  const _UnavailableMicrophonePermissionGateway();

  @override
  Future<MicrophonePermission> request() async =>
      MicrophonePermission.restricted;

  @override
  Future<bool> openSettings() async => false;
}

class _UnavailableVoiceRecorderFactory implements VoiceRecorderFactory {
  const _UnavailableVoiceRecorderFactory();

  @override
  VoiceRecorder create() => const _UnavailableVoiceRecorder();
}

class _UnavailableVoiceRecorder implements VoiceRecorder {
  const _UnavailableVoiceRecorder();

  @override
  double? get silenceThresholdRms => null;

  @override
  Stream<double> get amplitude => const Stream.empty();

  @override
  Stream<void> get interruptions => const Stream.empty();

  @override
  bool get supported => false;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {}

  @override
  Future<void> start() async {}

  @override
  Future<VoiceTake> stop() {
    throw const VoiceInputException(
      VoiceInputErrorKind.unavailable,
      'Voice input is unavailable.',
    );
  }
}
